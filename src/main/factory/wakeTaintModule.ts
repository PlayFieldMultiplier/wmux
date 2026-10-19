// The wake-taint tracker (wakeTaint.ts) as a factory module: built at start
// from main's stores, and fed every `handoff.received` fact so each handoff
// carries its sender wake's mark.

import path from 'node:path';
import type { WakeItem } from '../../shared/wake';
import { registerFactoryRpcModule } from './factoryHost';
import { TAINT_FILENAME, WakeTaint, runningTurnGuestSourced, setWakeTaint } from './wakeTaint';
import { setGuestTurnProbe } from './roomWriter';
import { getBotWorkflowStore } from './botWorkflow';

registerFactoryRpcModule('wakeTaint', (_router, deps) => {
  let off: (() => void) | null = null;
  return {
    async start() {
      const [{ getFactLog }, { getHandoffRouter }, { getTaskLedger }, { currentWakeItem }, { getBotRuntime }, { resolveFactsFrom }, { getBotDirectory }] = await Promise.all([
        import('./factLog'),
        import('./handoffRouter'),
        import('../deck/taskLedgerHost'),
        import('./wakeQueue'),
        import('./BotRuntime'),
        import('./factoryWiring'),
        import('./botStore'),
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
        workflow: (id) => getBotWorkflowStore()?.provenance(id) ?? null,
        runningWake,
        bot: (botId) => getBotDirectory()?.get(botId) ?? null,
        file: path.join(deps.wmuxDir(), 'factory', TAINT_FILENAME),
      });
      setWakeTaint(taint, runningWake);
      // A bot's card from a guest-sourced turn is stamped (RoomCard.origin).
      setGuestTurnProbe((botId) => runningTurnGuestSourced(botId) === true);
      const log = getFactLog();
      off = log ? log.subscribe((f) => taint.onFact(f)) : null;
    },
    dispose() {
      off?.();
      off = null;
      setGuestTurnProbe(null);
      setWakeTaint(null);
    },
  };
});
