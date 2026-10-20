import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconWarning } from '../icons';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { anyAgentReady } from '../../../shared/agentSetup';
import { refreshAgentStatus, useAgentSetup } from '../../utils/agentSetupRuns';

/** Wait after startup before probing, so the check never competes with restore. */
const FIRST_CHECK_DELAY_MS = 5_000;

/**
 * "Agent not set up · Set up": one muted row at the sidebar's foot, shown only
 * while neither Claude Code nor Codex is ready (installed and signed in), for
 * a user who chose "Later" in the setup wizard. The click reopens the wizard.
 *
 * Owner-approved sidebar slot (2026-10-21). Colour carries state only: neutral
 * text, no fill and no attention orange (nothing is asking for an answer);
 * the caution yellow is on the glyph alone. Detection runs once after
 * startup and whenever the wizard re-checks (shared state), never on a timer.
 */
export default function AgentNotReadyRow() {
  const t = useT();
  const { statuses } = useAgentSetup();
  const paneGate = useStore((s) => s.paneGate);

  useEffect(() => {
    if (paneGate !== 'ready' || statuses !== null) return;
    const timer = setTimeout(() => { void refreshAgentStatus(); }, FIRST_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [paneGate, statuses]);

  if (!statuses || anyAgentReady(statuses)) return null;
  return (
    <button
      type="button"
      className={`wmux-agent-not-ready ${FOCUS_RING}`}
      onClick={() => window.dispatchEvent(new CustomEvent(FIRST_RUN_REOPEN_EVENT))}
      data-testid="sidebar-agent-not-ready"
    >
      <span className="wmux-welcome-glyph-warn" aria-hidden="true"><IconWarning size={12} /></span>
      <span className="wmux-agent-not-ready-text">{t('sidebar.agentNotReady')}</span>
      <span aria-hidden="true">·</span>
      <span className="wmux-agent-not-ready-action">{t('sidebar.agentSetUp')}</span>
    </button>
  );
}
