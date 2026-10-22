import { useT } from '../../hooks/useT';
import { useBrowserAgentControl, sendBrowserAgentIntent } from '../../hooks/useBrowserAgentControl';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import Button from '../ui/Button';

/**
 * The browser pane's agent controls, in the toolbar row so they never move the
 * page: showing them must not resize the guest while an agent is acting on it.
 *
 *   agent, acting   ● Agent is using this tab   [Stop] [Take over]
 *   paused          Agent paused                [Resume] [Take over]
 *   user            You have this tab           [Hand back]
 *
 * Nothing is drawn for an idle agent tab. The running mark is the shared one
 * (StatusMarkView): this is the sidebar's running state, on the tab it is about.
 * All buttons are secondary — none of them is the one thing that unblocks the
 * user, so the toolbar gets no primary.
 */
export function BrowserAgentStatus({
  surfaceId,
  compact,
  hidden,
}: {
  surfaceId: string;
  /** Narrow toolbar: the words go, the mark and the buttons stay. */
  compact: boolean;
  /** Another band already speaks for the tab (an open help request). */
  hidden?: boolean;
}) {
  const t = useT();
  const state = useBrowserAgentControl(surfaceId);
  if (!state || (hidden && state.mode === 'agent')) return null;
  const { mode, active } = state;
  const label =
    mode === 'paused' ? t('browser.agent.paused')
      : mode === 'user' ? t('browser.agent.userControl')
        : t('browser.agent.driving');
  return (
    <div
      role="group"
      aria-label={t('browser.agent.controlsLabel')}
      data-browser-agent-control={mode}
      data-active={active ? 'true' : undefined}
      className="flex items-center gap-1.5 shrink-0 min-w-0"
      // The panel root hands every click to the webview; a button here keeps it.
      onClick={(e) => e.stopPropagation()}
    >
      {mode === 'agent' && <StatusMarkView status="running" label={compact ? label : undefined} />}
      {!compact && (
        <span
          data-browser-agent-label
          className="truncate"
          style={{ fontSize: 12, color: 'var(--text-sub)', maxWidth: 160 }}
          title={label}
        >
          {label}
        </span>
      )}
      {mode === 'agent' && (
        <Button
          size="sm"
          data-browser-agent-stop
          title={t('browser.agent.stopHint')}
          onClick={() => void sendBrowserAgentIntent(surfaceId, 'stop')}
        >
          {t('browser.agent.stop')}
        </Button>
      )}
      {mode === 'paused' && (
        <Button
          size="sm"
          data-browser-agent-resume
          title={t('browser.agent.resumeHint')}
          onClick={() => void sendBrowserAgentIntent(surfaceId, 'resume')}
        >
          {t('browser.agent.resume')}
        </Button>
      )}
      {mode === 'user' ? (
        <Button
          size="sm"
          data-browser-agent-hand-back
          aria-pressed
          // Pressed reads as the emphasis fill, never a colour (DESIGN.md).
          style={{ background: 'var(--selection-emphasis)' }}
          title={t('browser.agent.handBackHint')}
          onClick={() => void sendBrowserAgentIntent(surfaceId, 'handBack')}
        >
          {t('browser.agent.handBack')}
        </Button>
      ) : (
        <Button
          size="sm"
          data-browser-agent-take-over
          aria-pressed={false}
          title={t('browser.agent.takeOverHint')}
          onClick={() => void sendBrowserAgentIntent(surfaceId, 'takeOver')}
        >
          {t('browser.agent.takeOver')}
        </Button>
      )}
    </div>
  );
}

/** The tab strip's mark for a browser tab an agent is acting on. */
export function BrowserAgentTabMark({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const state = useBrowserAgentControl(surfaceId);
  if (!state?.active || state.mode !== 'agent') return null;
  return (
    <span className="shrink-0" data-browser-agent-tab-mark>
      <StatusMarkView status="running" label={t('browser.agent.driving')} />
    </span>
  );
}
