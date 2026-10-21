import type http from 'node:http';
import { A2A_REMOTE_IMAGE_LIMITS, A2A_ROUTES, A2A_SHA256_RE, type HostId } from '../../shared/a2aRemote';
import { inspectA2aImage } from '../../shared/a2aImages';
import type { A2aImageStore } from './imageStore';
import { sha256 } from './imageStore';
import type { OutboxStore } from './outboxStore';
import type { A2aRouteTable } from './routes';
import { readBodyBytes, sendJson } from './server';
import { errMsg } from './storeFile';

/**
 * The image routes of cross-host A2A (`images.1`), on the SERVER side. The
 * joiner dials either way, so it both pushes and pulls:
 *
 *   PUT /api/a2a/blobs/:sha256 — the joiner uploads one image ahead of the
 *       envelope that names it. Raw bytes, at most one image's size (counted
 *       as they arrive, whatever Content-Length said), hash and image
 *       structure checked, kept in that peer's staging share. Already here
 *       with those bytes: 200 before the body is read (the connection is then
 *       closed). At most one upload per peer and four in all at a time (each
 *       is held in memory), else 429.
 *   GET /api/a2a/blobs/:sha256 — the joiner fetches an image an envelope on
 *       its stream named: only while this PC still owes that peer such an
 *       envelope (an open outbox record names the hash); otherwise 404, so a
 *       peer never reads an image that was not sent to it. The same
 *       concurrency bounds as uploads (each answer is held in memory).
 */

/** Transfers held in memory at once, uploads and downloads each. */
const MAX_UPLOADS = 4;

export interface A2aImageRouteDeps {
  store: Pick<A2aImageStore, 'has' | 'stage' | 'readOutgoing'>;
  outbox: Pick<OutboxStore, 'pending'>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function registerImageRoutes(table: A2aRouteTable, deps: A2aImageRouteDeps): void {
  const pattern = `${A2A_ROUTES.blobs}/:sha256`;
  const uploads = slots();
  const downloads = slots();

  table.add('PUT', pattern, async ({ req, res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    if (!A2A_SHA256_RE.test(sha)) return refuseAndClose(req, res, 400, 'bad-request');
    const release = uploads.take(peer.hostId);
    if (!release) return refuseAndClose(req, res, 429, 'unavailable');
    try {
      if (await deps.store.has(peer.hostId, sha)) return answerAndClose(req, res, 200, { ok: true });
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
      await new Promise<void>((resolve) => {
        res.once('close', resolve);
        res.end(bytes);
      });
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

/** Answer without reading the body, then cut the connection (the body is never drained). */
function answerAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket.destroy());
  sendJson(res, status, body);
}

/** Refuse, then cut the connection: a body we did not read (or read only in part) is never drained. */
function refuseAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, error: string): void {
  answerAndClose(req, res, status, { ok: false, error });
}
