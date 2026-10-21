import type http from 'node:http';
import { finished } from 'node:stream/promises';
import { A2A_REMOTE_IMAGE_LIMITS, A2A_ROUTES, A2A_SHA256_RE, type HostId } from '../../shared/a2aRemote';
import { inspectA2aImage } from '../../shared/a2aImages';
import type { A2aImageStore } from './imageStore';
import { sha256 } from './imageStore';
import type { OutboxStore } from './outboxStore';
import type { A2aRouteTable } from './routes';
import { readBodyBytes, sendJson } from './server';
import { imageTransferBudgetMs } from './session';
import { errMsg } from './storeFile';

/**
 * The image routes of cross-host A2A (`images.1`), on the SERVER side. The
 * joiner dials either way, so it both pushes and pulls:
 *
 *   HEAD /api/a2a/blobs/:sha256 — whether a file under that hash is here
 *       already (uploaded or received): 200, else 404; 503 while the peer's
 *       upload slot is taken (the joiner then just uploads). By name and
 *       size only, never hashed and never refreshing a file's time: the
 *       bytes are checked when an envelope claims them, and a file that
 *       does not match is removed then, so the next attempt uploads again.
 *   PUT /api/a2a/blobs/:sha256 — the joiner uploads one image ahead of the
 *       envelope that names it. Raw bytes, at most one image's size (counted
 *       as they arrive, whatever Content-Length said), hash and image
 *       structure checked, kept in that peer's staging share. Already here
 *       with those bytes: 200. At most one upload per peer and four in all at
 *       a time (each is held in memory), else 429. Every early answer reads
 *       the body to its end first, counting and discarding it (one image at
 *       most, within DRAIN_MS): a socket closed on unread bytes is reset, and
 *       the client then loses the answer as well.
 *   GET /api/a2a/blobs/:sha256 — the joiner fetches an image an envelope on
 *       its stream named: only while this PC still owes that peer such an
 *       envelope (an open outbox record names the hash); otherwise 404, so a
 *       peer never reads an image that was not sent to it. The same
 *       concurrency bounds as uploads (each answer is held in memory), and a
 *       transfer that outlasts its size's budget is cut.
 */

/** Transfers held in memory at once, uploads and downloads each. */
const MAX_UPLOADS = 4;
/** How long an early answer waits for the body it discards. */
const DRAIN_MS = 30_000;

export interface A2aImageRouteDeps {
  store: Pick<A2aImageStore, 'has' | 'mayHave' | 'stage' | 'readOutgoing'>;
  outbox: Pick<OutboxStore, 'pending'>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seam; defaults to `imageTransferBudgetMs`. */
  transferBudgetMs?: (bytes: number) => number;
}

export function registerImageRoutes(table: A2aRouteTable, deps: A2aImageRouteDeps): void {
  const pattern = `${A2A_ROUTES.blobs}/:sha256`;
  const uploads = slots();
  const downloads = slots();

  const budget = deps.transferBudgetMs ?? imageTransferBudgetMs;

  table.add('HEAD', pattern, async ({ res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    const release = uploads.take(peer.hostId);
    if (!release) {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.once('close', release);
    try {
      const held = A2A_SHA256_RE.test(sha) && (await deps.store.mayHave(peer.hostId, sha));
      res.writeHead(held ? 200 : 404, { 'Cache-Control': 'no-store' });
      res.end();
    } finally {
      release();
    }
  });

  table.add('PUT', pattern, async ({ req, res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    if (!A2A_SHA256_RE.test(sha)) return drainThenAnswer(req, res, 400, { ok: false, error: 'bad-request' });
    const release = uploads.take(peer.hostId);
    if (!release) return drainThenAnswer(req, res, 429, { ok: false, error: 'unavailable' });
    // Before any wait: a client gone mid-request still gives the slot back.
    res.once('close', release);
    try {
      if (await deps.store.has(peer.hostId, sha)) return await drainThenAnswer(req, res, 200, { ok: true });
      const body = await readBodyBytes(req, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES);
      if (body === 'too-large') return refuseAndClose(req, res, 413, 'too-large');
      if (sha256(body) !== sha || !inspectA2aImage(body).ok) return sendJson(res, 400, { ok: false, error: 'bad-request' });
      try {
        await deps.store.stage(peer.hostId, sha, body);
      } catch (err) {
        deps.log('warn', `[a2a-remote] upload from ${peer.hostId} not kept: ${errMsg(err)}`);
        return sendJson(res, 503, { ok: false, error: 'unavailable' });
      }
      return sendJson(res, 200, { ok: true });
    } finally {
      release();
    }
  });

  table.add('GET', pattern, async ({ res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    if (!A2A_SHA256_RE.test(sha)) return sendJson(res, 400, { ok: false, error: 'bad-request' });
    const release = downloads.take(peer.hostId);
    if (!release) return sendJson(res, 429, { ok: false, error: 'unavailable' });
    res.once('close', release);
    try {
      const owed = deps.outbox.pending(peer.hostId).some((r) => r.envelope.images?.some((i) => i.sha256 === sha) === true);
      const bytes = owed ? await deps.store.readOutgoing(sha) : null;
      if (!bytes) return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      // A reader too slow for the budget is cut, which gives its slot back.
      const timer = setTimeout(() => res.destroy(), budget(bytes.length));
      res.end(bytes);
      await finished(res).catch(() => undefined);
      clearTimeout(timer);
    } finally {
      release();
    }
  });
}

/** One transfer per peer and MAX_UPLOADS in all; `take` answers the release, or null when full. */
function slots(): { take(hostId: HostId): (() => void) | null } {
  const perPeer = new Map<HostId, number>();
  let total = 0;
  return {
    take(hostId) {
      if ((perPeer.get(hostId) ?? 0) >= 1 || total >= MAX_UPLOADS) return null;
      perPeer.set(hostId, (perPeer.get(hostId) ?? 0) + 1);
      total += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (perPeer.get(hostId) ?? 1) - 1;
        if (n > 0) perPeer.set(hostId, n);
        else perPeer.delete(hostId);
        total -= 1;
      };
    },
  };
}

/**
 * Read the body to its end, counting and discarding it, then answer on a
 * connection that stays good. A body past one image, or one that has not
 * ended within DRAIN_MS, is answered and cut. Nothing is buffered.
 */
async function drainThenAnswer(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): Promise<void> {
  if (!(await discardBody(req, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES, DRAIN_MS))) return answerAndClose(req, res, status, body);
  sendJson(res, status, body);
}

/** True once the body ended within `max` bytes and `ms`; false past either, or on a read error. */
function discardBody(req: http.IncomingMessage, max: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      if (!ok) req.pause();
      resolve(ok);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) done(false);
    };
    const timer = setTimeout(() => done(false), ms);
    req.on('data', onData);
    req.once('end', () => done(size <= max));
    req.once('error', () => done(false));
    req.once('close', () => done(req.complete && size <= max));
    req.resume();
  });
}

/** Answer without reading the rest of the body, then cut the connection. */
function answerAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket.destroy());
  sendJson(res, status, body);
}

/** Refuse, then cut the connection: a body read only in part (over the cap) is never drained. */
function refuseAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, error: string): void {
  answerAndClose(req, res, status, { ok: false, error });
}
