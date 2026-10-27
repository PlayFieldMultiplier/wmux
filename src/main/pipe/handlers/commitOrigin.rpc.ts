// commit.origin — where a commit made in a wmux pane came from, as the daemon
// recorded it (daemon/commitOrigin): the pane, its workspace, the agent and
// that agent's own session, and the task, with how sure the record is. Read
// only; looked up by full SHA.
//
// Trust: `wmux.internal` (first-party readers). It names panes and agent
// sessions, so it is not offered to agents or the phone client.

import type { RpcRouter } from '../RpcRouter';
import { SHA_RE, type CommitOrigin } from '../../../shared/commitOrigin';

export function registerCommitOriginRpc(
  router: RpcRouter,
  lookup: (sha: string) => Promise<CommitOrigin | null | 'unavailable'>,
): void {
  router.register('commit.origin', async (params) => {
    const sha = typeof params['sha'] === 'string' ? params['sha'].trim().toLowerCase() : '';
    if (!SHA_RE.test(sha)) return { ok: false, reason: 'invalid' };
    const origin = await lookup(sha);
    if (origin === 'unavailable') return { ok: false, reason: 'unavailable' };
    return { ok: true, origin };
  });
}
