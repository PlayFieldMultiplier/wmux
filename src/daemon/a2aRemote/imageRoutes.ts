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
 *       structure checked, kept in that peer's staging share. Already here:
 *       200 at once. At most one upload per peer and four in all at a time
 *       (each is held in memory), else 429.
 *   GET /api/a2a/blobs/:sha256 — the joiner fetches an image an envelope on
 *       its stream named: only while this PC still owes that peer such an
 *       envelope (an open outbox record names the hash); otherwise 404, so a
 *       peer never reads an image that was not sent to it.
 */

const MAX_UPLOADS = 4;

export interface A2aImageRouteDeps {
  store: Pick<A2aImageStore, 'has' | 'stage' | 'readOutgoing'>;
  outbox: Pick<OutboxStore, 'pending'>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function registerImageRoutes(table: A2aRouteTable, deps: A2aImageRouteDeps): void {
  const inFlight = new Map<HostId, number>();
  let total = 0;
  const pattern = `${A2A_ROUTES.blobs}/:sha256`;

  table.add('PUT', pattern, async ({ req, res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    if (!A2A_SHA256_RE.test(sha)) return refuseAndClose(req, res, 400, 'bad-request');
    if ((inFlight.get(peer.hostId) ?? 0) >= 1 || total >= MAX_UPLOADS) return refuseAndClose(req, res, 429, 'unavailable');
    inFlight.set(peer.hostId, (inFlight.get(peer.hostId) ?? 0) + 1);
    total += 1;
    try {
      const body = await readBodyBytes(req, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES);
      if (body === 'too-large') return refuseAndClose(req, res, 413, 'too-large');
      if (deps.store.has(peer.hostId, sha)) return sendJson(res, 200, { ok: true });
      if (sha256(body) !== sha || !inspectA2aImage(body).ok) return sendJson(res, 400, { ok: false, error: 'bad-request' });
      try {
        await deps.store.stage(peer.hostId, sha, body);
      } catch (err) {
        deps.log('warn', `[a2a-remote] upload from ${peer.hostId} not kept: ${errMsg(err)}`);
        return sendJson(res, 503, { ok: false, error: 'unavailable' });
      }
      return sendJson(res, 200, { ok: true });
    } finally {
      const n = (inFlight.get(peer.hostId) ?? 1) - 1;
      if (n > 0) inFlight.set(peer.hostId, n);
      else inFlight.delete(peer.hostId);
      total -= 1;
    }
  });

  table.add('GET', pattern, async ({ res, params, peer }) => {
    const sha = params['sha256'] ?? '';
    if (!A2A_SHA256_RE.test(sha)) return sendJson(res, 400, { ok: false, error: 'bad-request' });
    const owed = deps.outbox.pending(peer.hostId).some((r) => r.envelope.images?.some((i) => i.sha256 === sha) === true);
    const bytes = owed ? await deps.store.readOutgoing(sha) : null;
    if (!bytes) return sendJson(res, 404, { ok: false, error: 'bad-request', message: 'not found' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
  });
}

/** Answer, then cut the connection: a body we did not read (or read only in part) is never drained. */
function refuseAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, error: string): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket.destroy());
  sendJson(res, status, { ok: false, error });
}
