// The wake-taint tracker (wakeTaint.ts) as a factory module: built at start
// from main's stores, and fed every `handoff.received` fact so each handoff
// carries its sender wake's mark.

import path from 'node:path';
import type { WakeItem } from '../../shared/wake';
import { registerFactoryRpcModule } from './factoryHost';
import { TAINT_FILENAME, WakeTaint, setWakeTaint } from './wakeTaint';

registerFactoryRpcModule('wakeTaint', (_router, deps) => {
  let off: (() => void) | null = null;
  return {
    async start() {
      const [{ getFactLog }, { getHandoffRouter }, { getTaskLedger }, { currentWakeItem }, { getBotRuntime }, { resolveFactsFrom }] = await Promise.all([
        import('./factLog'),
        import('./handoffRouter'),
        import('../deck/taskLedgerHost'),
        import('./wakeQueue'),
        import('./BotRuntime'),
        import('./factoryWiring'),
      ]);
      // The bot's running wake and when its turn began (the queue's item and
      // the runtime's turn must name the same wake).
      const runningWake = (botId: string): { item: WakeItem; startedAt: number } | null => {
        const item = currentWakeItem(botId);
        const turn = getBotRuntime()?.currentTurn(botId);
        return item && turn && turn.wakeId === item.id ? { item, startedAt: turn.startedAt } : null;
      };
      const taint = new WakeTaint({
        facts: (ids) => resolveFactsFrom(getFactLog(), ids),
        handoff: (id) => getHandoffRouter()?.get(id) ?? null,
        taskRow: (id) => getTaskLedger().get(id),
        runningWake,
        file: path.join(deps.wmuxDir(), 'factory', TAINT_FILENAME),
      });
      setWakeTaint(taint, runningWake);
      const log = getFactLog();
      off = log ? log.subscribe((f) => taint.onFact(f)) : null;
    },
    dispose() {
      off?.();
      off = null;
      setWakeTaint(null);
    },
  };
});
