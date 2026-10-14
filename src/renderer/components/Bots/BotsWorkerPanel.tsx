// ─── A bot worker's terminal, beside its bot's chat ──────────────────────
//
// Open on a worker bubble shows that worker's panes here, on the Bots page,
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
import { useStore } from '../../stores';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import PaneContainer from '../Pane/PaneContainer';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';

type T = (key: string, vars?: Record<string, string | number>) => string;

export default function BotsWorkerPanel({ workspaceId, hosted, name, state, attention, t, onClose }: {
  workspaceId: string;
  /** The panel hosts the workspace's panes (selectWorkerPanelHost); false:
   *  it stays on Workspaces and the panel offers the way there. */
  hosted: boolean;
  /** The worker's name as its bubble shows it (its task's title). */
  name: string;
  /** Its state in words (its bubble's line), or null. */
  state: string | null;
  /** The worker waits on the owner: the state line is the needs-you text. */
  attention: boolean;
  t: T;
  onClose: () => void;
}): React.ReactElement | null {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  if (!workspace) return null;
  return (
    <aside className="wmux-bots-worker" data-bots-worker-panel={workspaceId} aria-label={t('botsPage.chat.workerPanel', { name })}>
      <div className="wmux-bots-worker-head">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{name}</span>
          {state && (
            <span data-bots-worker-panel-state className={`block truncate text-[11px] ${attention ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'}`}>{state}</span>
          )}
        </span>
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
      {/* The panes fill the body as they fill a workspace slot. */}
      <div className="wmux-bots-worker-body">
        {hosted ? (
          <div className="wmux-bots-worker-panes">
            <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible />
          </div>
        ) : (
          <div data-bots-worker-panel-elsewhere className="flex flex-col items-start gap-3 px-3 py-4">
            <p className="text-[12px] text-[var(--text-muted)]">{t('botsPage.chat.workerElsewhere')}</p>
            <Button size="sm" variant="secondary" onClick={() => { focusNotificationTarget(() => useStore.getState(), { workspaceId }); }}>
              {t('botsPage.chat.openInWorkspaces')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
