// ─── The room dock ───────────────────────────────────────────────────────────
//
// The right slot while the agent factory is on (AppLayout swaps it for Moa's
// panel; the slot, its width rule and its toggle stay). It shows one room:
// the active workspace's, or the HQ's (Moa's room) — the header switches
// between them while an HQ exists, and the HQ's own workspace always shows
// the HQ room. Top to bottom: the 40px header, the room's bots (in the HQ,
// its strip of every bot holds them instead), the HQ's pinned plan / report
// and every bot (HQ only), the threads, the shown thread's cards, the
// composer.
//
// The slot is 248–320px wide, so the threads sit above the cards (a fold)
// rather than beside them. The cards keep at least 40% of the height: the
// HQ's pinned cards and the threads give way first. The HQ room lists only
// the threads with an open question (and the one shown) until the owner asks
// for all of them.
//
// With the factory off the dock says what the factory is, with one primary
// (Turn on, through the factory settings port) and a way to its settings.
import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { selectLocalWorkspaceId } from '../../stores/shadowWorkspace';
import { ALL_THREADS, type TimelineThread } from '../../stores/slices/roomSlice';
import { loadRoomActors, loadRoomThreads, refreshRoomStatus } from '../../hooks/useRoomSync';
import type { ThreadSummary } from '../../../shared/room';
import { DOCK_WIDTH_CSS } from '../Layout/dockLayout';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import SegmentedControl from '../ui/SegmentedControl';
import Button from '../ui/Button';
import { BotChips } from './BotChips';
import { HqRoom } from './HqRoom';
import { RoomComposer } from './RoomComposer';
import { RoomTimeline } from './RoomTimeline';
import { ThreadList } from './ThreadList';
import { useFactoryBots } from './useFactoryBots';
import { getFactorySettingsPort } from './factoryPorts';
import { isRefThread, threadLabel, threadRef } from './roomFormat';

const EMPTY_THREADS: ThreadSummary[] = [];

/** The room the dock shows: the HQ's when it is asked for or active, else
 *  the active workspace's. */
export function dockRoom(activeWorkspaceId: string, hqWorkspaceId: string | null, scope: 'workspace' | 'hq'): string {
  if (hqWorkspaceId && (scope === 'hq' || activeWorkspaceId === hqWorkspaceId || !activeWorkspaceId)) return hqWorkspaceId;
  return activeWorkspaceId;
}

/** How far the HQ's pinned cards and the threads give way, as floors that
 *  scale with the dock: full (the plan's title and answers; the threads
 *  toggle, the "All activity" row and one whole two-line thread row) in a
 *  dock of 750px, less as it shortens, never under one 28px row — so at the
 *  window's minimum height (600) the header, both floors, the timeline's 40%
 *  and the composer still fit. */
export const HQ_PINNED_MIN_HEIGHT = 'clamp(28px, calc(31% - 100px), 132px)';
export const THREADS_MIN_HEIGHT = 'clamp(28px, calc(32% - 128px), 112px)';

/** The HQ room's threads while folded to what needs the owner: those with
 *  an open question, and the shown one. Pure. */
export function hqVisibleThreads(threads: readonly ThreadSummary[], selected: TimelineThread): ThreadSummary[] {
  return threads.filter((th) => th.openQuestions > 0 || th.threadId === selected);
}

type T = ReturnType<typeof useT>;

/** The dock while the factory is off: what it is, Turn on, and its settings. */
export function FactoryOffState({ t }: { t: T }): React.ReactElement {
  const port = getFactorySettingsPort();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await port.set({ enabled: true });
      if (!next) setError(t('settings.factory.notStarted'));
      await refreshRoomStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="room-factory-off" className="px-3 pt-1 pb-3 flex flex-col gap-2.5">
      <p className="text-[13px] leading-relaxed text-[var(--text-sub)]">{t('room.dock.off')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {port.available && (
          <Button size="sm" variant={busy ? 'secondary' : 'primary'} data-testid="room-factory-turn-on" disabled={busy} onClick={() => void turnOn()}>
            {t('room.dock.turnOn')}
          </Button>
        )}
        <Button size="sm" variant="ghost" data-testid="room-factory-settings" onClick={() => useStore.getState().openSettingsTab('factory')}>
          {t('room.dock.factorySettings')}
        </Button>
      </div>
      {error && <p role="alert" className="text-[11px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

export default function RoomDock(): React.ReactElement {
  const t = useT();
  const status = useStore((s) => s.roomStatus);
  const activeWorkspaceId = useStore(selectLocalWorkspaceId);
  const scope = useStore((s) => s.roomScope);
  const setScope = useStore((s) => s.setRoomScope);
  const hq = status?.hqWorkspaceId ?? null;
  const workspaceId = dockRoom(activeWorkspaceId, hq, scope);
  const isHq = !!hq && workspaceId === hq;
  const threads = useStore((s) => s.roomThreads[workspaceId]) ?? EMPTY_THREADS;
  const selected: TimelineThread = useStore((s) => s.roomSelectedThread[workspaceId]) ?? ALL_THREADS;
  const selectThread = useStore((s) => s.selectRoomThread);
  const workspaceName = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '');
  const nameOf = (id: string) => useStore.getState().workspaces.find((w) => w.id === id)?.name ?? id;
  const bots = useFactoryBots(workspaceId || null);
  const allBots = useFactoryBots(null);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [allThreadsShown, setAllThreadsShown] = useState(false);
  const off = !!status && !status.enabled;

  useEffect(() => {
    if (!workspaceId || off) return;
    void loadRoomThreads(workspaceId);
    void loadRoomActors();
    const onFocus = () => { void loadRoomThreads(workspaceId); void loadRoomActors(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [workspaceId, off]);

  const openQuestions = threads.reduce((n, th) => n + th.openQuestions, 0);
  const folded = isHq && !allThreadsShown;
  const listed = folded ? hqVisibleThreads(threads, selected) : threads;
  const hidden = threads.length - listed.length;
  const selectedTitle = selected === ALL_THREADS
    ? t('room.thread.all')
    : selected === 'general'
      ? t('room.thread.general')
      : threads.find((th) => th.threadId === selected)?.title ?? threadLabel(selected, t);

  return (
    <div
      className="wmux-dock flex flex-col h-full bg-[var(--bg-base)]"
      style={{ width: DOCK_WIDTH_CSS, maxWidth: '100%' }}
      id="wmux-tools-panel"
      data-testid="room-dock"
      data-room-workspace={workspaceId}
      data-room-hq={isHq ? 'true' : undefined}
      aria-label={t('room.dock.label')}
      role="complementary"
      {...tokenAttrs('bgBase', 'bg')}
    >
      <div className="h-[40px] shrink-0 flex items-center gap-2 px-3">
        <h2 className="text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)] shrink-0">
          {isHq ? t('room.dock.hqTitle') : t('room.dock.title')}
        </h2>
        {!isHq && workspaceName && <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{workspaceName}</span>}
        {!off && hq && activeWorkspaceId && activeWorkspaceId !== hq && (
          <div className="ml-auto shrink-0">
            <SegmentedControl
              value={scope}
              ariaLabel={t('room.dock.scope')}
              options={[
                { value: 'workspace', label: t('room.dock.scopeWorkspace') },
                { value: 'hq', label: t('room.dock.scopeHq') },
              ]}
              onValueChange={setScope}
            />
          </div>
        )}
      </div>

      {off ? <FactoryOffState t={t} /> : (
        <>
          {status && !status.running && (
            <p data-testid="room-not-running" className="px-3 pb-2 text-[12px] text-[var(--text-muted)]">{t('room.dock.notRunning')}</p>
          )}

          {!isHq && bots.length > 0 && <div className="px-3 pb-2"><BotChips rows={bots} t={t} /></div>}

          {isHq && <HqRoom workspaceId={workspaceId} t={t} workspaceName={nameOf} allBots={allBots} minHeight={HQ_PINNED_MIN_HEIGHT} />}

          {/* The threads give way before the cards (the timeline keeps 40%),
              down to their floor (THREADS_MIN_HEIGHT) — none while no thread
              row is listed, so a short list leaves no empty reserve. */}
          <div
            data-testid="room-threads"
            className={`shrink flex flex-col ${threadsOpen ? 'max-h-[30%]' : ''}`}
            style={{ minHeight: threadsOpen ? (listed.length > 0 ? THREADS_MIN_HEIGHT : undefined) : 28 }}
          >
            <button
              type="button"
              data-testid="room-threads-toggle"
              aria-expanded={threadsOpen}
              onClick={() => setThreadsOpen((v) => !v)}
              className={`shrink-0 mx-1 px-2 h-[28px] flex items-center gap-1.5 rounded-[6px] text-[12px] text-[var(--text-sub)] hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
            >
              <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className={`transition-transform ${threadsOpen ? 'rotate-90' : ''}`}>
                <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              <span>{t('room.threads')}</span>
              <span className="tabular-nums text-[var(--text-muted)]">{threads.length}</span>
              {(!threadsOpen || folded) && openQuestions > 0 && (
                <span className="ml-auto tabular-nums text-[var(--attention-text)]" data-threads-questions>
                  {t('room.thread.openQuestions', { count: openQuestions })}
                </span>
              )}
            </button>
            {threadsOpen && (
              <div className="min-h-0 overflow-y-auto pb-1">
                <ThreadList threads={listed} selected={selected} onSelect={(th) => selectThread(workspaceId, th)} t={t} />
                {isHq && (hidden > 0 || allThreadsShown) && (
                  <button
                    type="button"
                    data-testid="room-threads-show-all"
                    aria-expanded={allThreadsShown}
                    onClick={() => setAllThreadsShown((v) => !v)}
                    className={`mx-3 mt-1 text-[12px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                  >
                    {allThreadsShown ? t('room.threads.showFewer') : t('room.threads.showAll', { count: hidden })}
                  </button>
                )}
              </div>
            )}
          </div>

          {workspaceId ? (
            <RoomTimeline
              key={`${workspaceId}:${selected}`}
              workspaceId={workspaceId}
              thread={selected}
              title={selectedTitle}
              threadRef={selected !== ALL_THREADS && isRefThread(selected) ? threadRef(selected, t) : null}
              t={t}
              bots={bots}
            />
          ) : (
            <p className="flex-1 px-3 py-4 text-[12px] text-[var(--text-muted)]">{t('room.dock.noWorkspace')}</p>
          )}

          {workspaceId && (
            <div className="shrink-0 px-2 pb-2 pt-1">
              <RoomComposer
                workspaceId={workspaceId}
                threadId={selected === ALL_THREADS ? 'general' : selected}
                bots={allBots}
                t={t}
                onAddBot={() => useStore.getState().openSettingsTab('factory')}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
