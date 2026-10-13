// The approval store (approvals.ts) as a factory module: its bot RPCs, and
// at start the store itself with main's ports, fed every fact (an owner's
// message may approve) and resuming approved merges due after a restart.
// Registered from modules.ts only, so it starts after the fact log, the bot
// runtime, the rooms and the merge lane it reads.

import path from 'node:path';
import type { Fact } from '../../shared/facts';
import { APPROVALS_FILENAME, APPROVAL_LIMITS, ApprovalService, getApprovalService, registerApprovalRpc, setApprovalService } from './approvals';
import { registerFactoryRpcModule, type FactoryHostDeps } from './factoryHost';

registerFactoryRpcModule('approvals', (router, deps: FactoryHostDeps) => {
  registerApprovalRpc(router, getApprovalService);
  let off: (() => void) | null = null;
  return {
    async start() {
      const [{ getFactLog }, { getBotDirectory }, { getRoomWriter }, laneGh, { currentWakeItem, latestOwnerWakeThread, getWakeQueue }, { getBotRuntime }, { getWakeTaint }, { getApprovalMergeHost }, { BOT_EVENT }] = await Promise.all([
        import('./factLog'),
        import('./botStore'),
        import('./roomWriter'),
        import('./laneGh'),
        import('./wakeQueue'),
        import('./BotRuntime'),
        import('./wakeTaint'),
        import('./mergeLaneHost'),
        import('../../shared/bot'),
      ]);
      const { noticeBot } = await import('./botNotices');
      let service: ApprovalService;
      try {
        service = new ApprovalService({
          file: path.join(deps.wmuxDir(), 'factory', APPROVALS_FILENAME),
          bots: getBotDirectory,
          runningWake: (botId) => {
            const item = currentWakeItem(botId);
            const turn = getBotRuntime()?.currentTurn(botId);
            if (!item || !turn || turn.wakeId !== item.id) return null;
            const taint = getWakeTaint();
            return {
              wakeId: item.id, attempt: Math.max(1, item.attempts), threadId: item.threadId ?? null,
              tainted: taint ? taint.wakeTainted(item) : true, ownerWords: item.reason.kind === 'human',
            };
          },
          conversationThread: latestOwnerWakeThread,
          readPr: (repoPath, key, n) => laneGh.freshLaneFacts.readFresh(repoPath, key, n),
          ghLogin: laneGh.currentGhLogin,
          rooms: getRoomWriter,
          merge: getApprovalMergeHost,
          appendFact: (d) => getFactLog()?.append(d) ?? null,
          notice: (n) => {
            noticeBot({ factLog: getFactLog, wakes: getWakeQueue }, n);
          },
          emit: (payload) => {
            const win = deps.getMainWindow();
            if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
          },
        });
      } catch (err) {
        console.warn(`[factory] approvals did not start: ${String(err)}`);
        return;
      }
      setApprovalService(service);
      const log = getFactLog();
      off = log ? log.subscribe((f) => service.onFact(f)) : null;
      service.resume();
      // Merges the log kept from while the app was down settle their requests.
      try {
        const since = Date.now() - APPROVAL_LIMITS.PENDING_TTL_MS;
        const kept = (log as { readWhere?: (after: number, match: (f: Fact) => boolean, limit: number) => { facts: Fact[] } } | null)
          ?.readWhere?.(0, (f) => (f.kind === 'merge.done' || f.kind === 'pr.merged') && f.at >= since, 1000);
        if (kept) service.settleMergedSince(kept.facts);
      } catch (err) {
        console.warn(`[factory] approvals: merges before start not read: ${String(err)}`);
      }
    },
    dispose() {
      off?.();
      off = null;
      getApprovalService()?.stop();
      setApprovalService(null);
    },
  };
});
