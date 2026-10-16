// ─── A bot worker's terminal, beside its bot's chat ──────────────────────
//
// A worker row under its bot in the list shows that worker's panes here, on the Bots page,
// instead of jumping to Workspaces: the app's active workspace never changes
// (owner decision 2026-10-14). The worker's workspace keeps one mount (one
// xterm per PTY): while this panel shows it, the Workspaces viewport leaves
// that workspace unmounted (selectWorkerPanelHost), and it mounts there
// again, replaying from the daemon, when the panel closes or the page goes.
// Keys typed here reach the worker's PTY only; the Workspaces shortcuts stay
// off on this page (useKeyboard), and a click never activates the workspace
// (setActivePane is scoped to the active one). A worker that also holds a
// browser or an editor is not moved here (selectWorkerPanelHost: their state
// would not survive the remount); the panel says so and offers Workspaces.
import { useState } from 'react';
import { useStore } from '../../stores';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import PaneContainer from '../Pane/PaneContainer';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';
import { WorkerMenu, WorkerStopConfirm } from './BotsWorkerMenu';
import type { BotsStopPort } from './botsStop';

type T = (key: string, vars?: Record<string, string | number>) => string;

const openInWorkspaces = (workspaceId: string) => focusNotificationTarget(() => useStore.getState(), { workspaceId }, { reveal: true });

export default function BotsWorkerPanel({ workspaceId, hosted, name, state, attention, t, onClose, onResume, stop, style }: {
  workspaceId: string;
  /** The panel hosts the workspace's panes (selectWorkerPanelHost); false:
   *  it stays on Workspaces and the panel offers the way there. */
  hosted: boolean;
  /** The worker's name as its row shows it (its task's title). */
  name: string;
  /** Its state in words (its row's), or null. */
  state: string | null;
  /** The worker waits on the owner: the state is the needs-you text. */
  attention: boolean;
  t: T;
  onClose: () => void;
  /** Resumes an ended task's stopped worker (absent: not resumable). */
  onResume?: () => void;
  /** Stops this live worker, its task cancelled (absent: not offered). */
  stop?: { taskId: string; stopTask: NonNullable<BotsStopPort['stopTask']> };
  /** The panel's width beside the chat (the splitter's). */
  style?: React.CSSProperties;
}): React.ReactElement | null {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  // Stop worker's confirm, under the header; it belongs to the worker shown.
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  if (!workspace) return null;
  const confirming = !!stop && confirmStop === stop.taskId;
  return (
    <aside className="wmux-bots-worker" data-bots-worker-panel={workspaceId} aria-label={t('botsPage.chat.workerPanel', { name })} style={style}>
      {/* One line: the name, its state, the menu, Close. */}
      <div className="wmux-bots-worker-head">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{name}</span>
          {state && (
            <span data-bots-worker-panel-state className={`shrink-0 truncate text-[11px] ${attention ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'}`}>{`· ${state}`}</span>
          )}
        </span>
        <WorkerMenu
          attr="data-bots-worker-panel"
          t={t}
          buttonClassName="wmux-bots-icon-button"
          onOpenInWorkspaces={() => openInWorkspaces(workspaceId)}
          onResume={onResume}
          onStop={stop ? () => setConfirmStop(stop.taskId) : undefined}
        />
        <button
          type="button"
          data-bots-worker-panel-close
          onClick={onClose}
          aria-label={t('botsPage.chat.closeWorker')}
          title={t('botsPage.chat.closeWorker')}
          className={`wmux-bots-icon-button ${FOCUS_RING}`}
        >
          <IconX size={14} />
        </button>
      </div>
      {confirming && stop && (
        <div className="px-3 py-2" data-bots-worker-panel-stop-confirm>
          <WorkerStopConfirm task={name} taskId={stop.taskId} stopTask={stop.stopTask} t={t} testId="bots-stop-worker-panel" onClose={() => setConfirmStop(null)} />
        </div>
      )}
      {/* The terminal right under the header: the pane's tab strip and its
          split, browser and zoom controls are Workspaces' (bots.css hides
          them here — this panel only views the worker). */}
      <div className="wmux-bots-worker-body">
        {hosted ? (
          <div className="wmux-bots-worker-panes">
            <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible />
          </div>
        ) : (
          <div data-bots-worker-panel-elsewhere className="flex flex-col items-start gap-3 px-3 py-4">
            <p className="text-[12px] text-[var(--text-muted)]">{t('botsPage.chat.workerElsewhere')}</p>
            <Button size="sm" variant="secondary" onClick={() => { openInWorkspaces(workspaceId); }}>
              {t('botsPage.chat.openInWorkspaces')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
