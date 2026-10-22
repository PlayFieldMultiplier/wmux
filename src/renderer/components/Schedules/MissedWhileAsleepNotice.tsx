import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { selectMissedWhileAsleep } from '../../stores/selectors/schedules';
import Button from '../ui/Button';
import { runMissedNow } from './missedWhileAsleep';

/**
 * "N runs missed while asleep" under the Schedules list header, after the
 * system slept through scheduled runs (selectMissedWhileAsleep). Run now starts
 * each affected schedule once; Skip leaves them missed. Either answers it, and
 * the sidebar's Schedules row counts it as needing you until then.
 */
export function MissedWhileAsleepNotice() {
  const t = useT();
  const missed = useStore(useShallow(selectMissedWhileAsleep));
  const [busy, setBusy] = useState(false);
  if (missed.count === 0) return null;

  const runNow = async () => {
    const api = window.electronAPI?.automation;
    if (!api) return;
    setBusy(true);
    try {
      const outcome = await runMissedNow(missed.automationIds, api);
      const store = useStore.getState();
      if (outcome.started > 0) store.pushToast({ level: 'info', message: t('schedules.runNowStarted') });
      for (const run of outcome.skipped) {
        store.pushToast({ level: 'warn', message: t('schedules.runNowSkipped', { reason: run.reason ? t(`schedules.reason.${run.reason}`) : '' }) });
      }
      if (outcome.failed > 0) store.pushToast({ level: 'warn', message: t('schedules.missedRunNowFailed', { count: outcome.failed }) });
      store.dismissSleepNotice();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wmux-schedules-missed" role="status" data-schedules-missed>
      <p className="ui-row-title">
        {missed.count === 1 ? t('schedules.missedAsleep.one') : t('schedules.missedAsleep.other', { count: missed.count })}
      </p>
      <p className="ui-row-detail">{t('schedules.missedAsleepDetail')}</p>
      <div className="wmux-schedules-missed-actions">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void runNow()} data-schedules-missed-run>
          {t('schedules.runNow')}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => useStore.getState().dismissSleepNotice()} data-schedules-missed-skip>
          {t('schedules.missedSkip')}
        </Button>
      </div>
    </div>
  );
}
