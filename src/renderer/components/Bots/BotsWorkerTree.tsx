// ─── A bot's workers, nested under its row in the list ───────────────────
//
// Owner decision 2026-10-14: the Bots list shows each bot's workers the way
// the Sidebar shows a workspace's fan-out tasks — an indented row per worker
// on a hairline guide, its status mark, the fan-out mark and the task's
// title, and under it the branch with its diff counts. Live workers come
// first, then ended tasks whose workspace is still open (botWorkerTree); a
// row drops off when its workspace is cleared. A click shows the worker's
// terminal in the panel beside the chat (BotsWorkerPanel); the row it shows
// is selected. The rows reuse the Sidebar's marks (StatusMarkView,
// GitSyncBadge, IconFanOut, IconGitBranch), not its task group, whose menu
// closes worktrees.
import { useStore } from '../../stores';
import type { AgentStatus } from '../../../shared/types';
import { FOCUS_RING } from '../focusRing';
import { IconChevron, IconFanOut, IconGitBranch } from '../icons';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import { GitSyncBadge } from '../Sidebar/WorkspaceItem';
import type { BotTreeRow } from './botsModel';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The Sidebar's status mark for a tree row's state. */
const ROW_STATUS: Record<BotTreeRow['state'], AgentStatus> = {
  running: 'running',
  needsYou: 'awaiting_input',
  error: 'error',
  done: 'complete',
  failed: 'error',
};

/** A tree row's state in words. */
export function treeRowState(row: BotTreeRow, t: T): string {
  switch (row.state) {
    case 'running': return t('botsPage.worker.running');
    case 'needsYou': return t(row.needsInput ? 'botsPage.worker.needsInput' : 'botsPage.worker.waiting');
    case 'error': return t('botsPage.worker.errored');
    case 'done': return t('botsPage.worker.done');
    case 'failed': return t('botsPage.worker.failed');
  }
}

function TreeRow({ row, selected, t, onOpen }: { row: BotTreeRow; selected: boolean; t: T; onOpen: () => void }) {
  const meta = useStore((s) => s.workspaces.find((w) => w.id === row.workspaceId)?.metadata);
  const state = treeRowState(row, t);
  const needsYou = row.state === 'needsYou';
  return (
    <button
      type="button"
      data-bots-worker={row.workspaceId}
      data-worker-state={row.state}
      data-worker-needs-input={row.needsInput ? 'true' : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${row.title}, ${state}`}
      title={`${row.title} · ${state}`}
      onClick={onOpen}
      className={`wmux-bots-tree-row ${selected ? 'is-selected' : ''} ${FOCUS_RING}`}
    >
      <span className="mt-1 flex-none">
        <StatusMarkView status={ROW_STATUS[row.state]} quiet={!needsYou} label={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="flex-none text-[var(--text-muted)]" aria-hidden="true"><IconFanOut size={10} /></span>
          <span className={`min-w-0 truncate text-[12px] ${row.state === 'done' || row.state === 'failed' ? 'text-[var(--text-sub)]' : 'text-[var(--text-main)]'}`}>{row.title}</span>
        </span>
        {/* What a worker waiting on input asks, in the needs-you text. */}
        {row.summary && (
          <span data-bots-worker-summary title={row.summary} className="mt-0.5 block truncate text-[11px] text-[var(--attention-text)]">{row.summary}</span>
        )}
        {meta?.gitBranch && (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4 tabular-nums text-[color-mix(in_srgb,var(--text-main)_45%,transparent)]" data-bots-worker-branch>
            <span className="min-w-0 truncate">
              <span className="mr-1 inline-flex align-[-2px]" aria-hidden="true"><IconGitBranch size={12} /></span>
              {meta.gitBranch}
            </span>
            {meta.gitSync && <GitSyncBadge sync={meta.gitSync} />}
          </span>
        )}
      </span>
    </button>
  );
}

/** The fold toggle on a bot's row: a chevron and how many workers it has. */
export function TreeToggle({ count, expanded, controls, name, t, onToggle }: {
  count: number;
  expanded: boolean;
  controls: string;
  name: string;
  t: T;
  onToggle: () => void;
}) {
  const label = t(expanded ? 'botsPage.worker.collapse' : 'botsPage.worker.expand', { name, count });
  return (
    <button
      type="button"
      data-bots-tree-toggle
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={`wmux-bots-tree-toggle ${FOCUS_RING}`}
    >
      <span className="tabular-nums">{count}</span>
      <span className="inline-flex transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : undefined }} aria-hidden="true">
        <IconChevron size={8} />
      </span>
    </button>
  );
}

export default function BotsWorkerTree({ id, rows, name, shownId, t, onOpen }: {
  id: string;
  rows: readonly BotTreeRow[];
  /** The bot's name (the group's accessible name). */
  name: string;
  /** The worker shown in the panel for this bot, or null. */
  shownId: string | null;
  t: T;
  onOpen: (workspaceId: string) => void;
}) {
  return (
    <div id={id} role="group" aria-label={t('botsPage.worker.treeOf', { name })} className="wmux-bots-tree" data-bots-tree>
      {rows.map((row) => (
        <TreeRow key={row.workspaceId} row={row} selected={shownId === row.workspaceId} t={t} onOpen={() => onOpen(row.workspaceId)} />
      ))}
    </div>
  );
}
