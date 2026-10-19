// #2263 — after the daemon drops main's event subscription and the health
// probe subscribes again, everything pushed in between is gone. The resync
// reads each pane from the daemon once and corrects only where the pane shows
// something else, without notifying anyone.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const last = new Map<string, string>();
  const broadcastMetadataUpdate = vi.fn((_win: unknown, payload: { ptyId?: string; agentStatus?: string }) => {
    if (payload.ptyId && payload.agentStatus !== undefined) last.set(payload.ptyId, payload.agentStatus);
  });
  return { last, broadcastMetadataUpdate };
});

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: mocks.broadcastMetadataUpdate,
  getLastBroadcastAgentStatus: (ptyId: string) => mocks.last.get(ptyId),
  hasOutstandingRunningClaim: () => false,
}));

import { resyncAfterResubscribe, type DaemonPaneState, type DaemonSessionRow } from '../resubscribeResync';
import { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { SignalLatencyMeter } from '../../../shared/hooks/SignalLatencyMeter';

function run(
  states: Record<string, DaemonPaneState | null>,
  router: HookSignalRouter | null = null,
  opts: {
    rows?: DaemonSessionRow[];
    tracked?: Map<string, string>;
    liveCwdDuringList?: [string, string];
    liveLifecycleDuringList?: string;
  } = {},
) {
  const titles: Array<[string, string]> = [];
  const died: Array<[string, number | null, number | undefined]> = [];
  const cwds: Array<[string, string]> = [];
  const read: string[] = [];
  const tracked = opts.tracked ?? new Map<string, string>();
  let live: ((kind: 'cwd' | 'lifecycle', id: string) => void) | null = null;
  const result = resyncAfterResubscribe({
    listSessions: async () => {
      // A live cwd event processed before the resync reads the reply.
      if (opts.liveCwdDuringList) {
        const [id, cwd] = opts.liveCwdDuringList;
        tracked.set(id, cwd);
        live?.('cwd', id);
      }
      if (opts.liveLifecycleDuringList) live?.('lifecycle', opts.liveLifecycleDuringList);
      return opts.rows ?? Object.keys(states).map((id) => ({ id, state: 'attached' }));
    },
    trackedCwd: (id) => tracked.get(id),
    readState: async (id) => { read.push(id); return states[id] ?? null; },
    // As live: the died listeners drop main's record of the session.
    emitDied: (id, exitCode, signal) => { died.push([id, exitCode, signal]); tracked.delete(id); },
    emitCwd: (id, cwd) => { cwds.push([id, cwd]); tracked.set(id, cwd); },
    onLiveEvent: (listener) => { live = listener; return () => { live = null; }; },
    emitTitle: (id, title) => { titles.push([id, title]); },
    hookRouter: router,
    win: null,
  });
  return { result, titles, died, cwds, read };
}

function statuses(): Array<{ ptyId?: string; agentStatus?: string; settled?: boolean }> {
  return mocks.broadcastMetadataUpdate.mock.calls.map((c) => c[1] as { ptyId?: string; agentStatus?: string; settled?: boolean });
}

describe('resyncAfterResubscribe (#2263)', () => {
  let router: HookSignalRouter;

  beforeEach(() => {
    mocks.last.clear();
    mocks.broadcastMetadataUpdate.mockClear();
    router = new HookSignalRouter({ latencyMeter: new SignalLatencyMeter() });
  });

  it('lights a pane whose turn started in the gap (a missed `active`)', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true } });
    expect((await result).statusesCorrected).toBe(1);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'running', agentName: 'Codex' }]);
  });

  it('reads an open turn that is thinking quietly as running, and takes the latch its missed hook would have set', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: true, hookReports: true } }, router);
    await result;
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'running', agentName: 'Claude Code' }]);
    expect(router.governsRunningState('d1')).toBe(true);
  });

  it('takes no latch for a turn open without hooks', async () => {
    mocks.last.set('d1', 'idle');
    const { result } = run({ d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true, hookReports: false } }, router);
    await result;
    expect(router.governsRunningState('d1')).toBe(false);
  });

  it('settles a pane whose turn ended in the gap, latch and activity stamp included', async () => {
    mocks.last.set('d1', 'running');
    router.noteHookTurnStart('d1', Date.now(), 'claude');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: false } }, router);
    expect((await result).statusesCorrected).toBe(1);
    expect(router.governsRunningState('d1')).toBe(false);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'idle', settled: true }]);
  });

  it('shows a result reached in the gap and releases the latch, without a notification path', async () => {
    mocks.last.set('d1', 'running');
    router.noteHookTurnStart('d1', Date.now(), 'claude');
    const { result } = run({ d1: { agentStatus: 'complete', agentName: 'Claude Code', turnOpen: false } }, router);
    await result;
    expect(router.governsRunningState('d1')).toBe(false);
    expect(statuses()).toEqual([{ ptyId: 'd1', agentStatus: 'complete', agentName: 'Claude Code' }]);
  });

  it('leaves an unread result alone when the daemon pane is idle', async () => {
    mocks.last.set('d1', 'complete');
    mocks.last.set('d2', 'waiting');
    const { result } = run({
      d1: { agentStatus: 'idle', agentName: 'Claude Code', turnOpen: false },
      d2: { agentStatus: 'idle', agentName: 'Codex', turnOpen: false },
    });
    expect((await result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('does not act on an idle status from an older daemon that cannot say whether a turn is open', async () => {
    mocks.last.set('d1', 'running');
    const { result } = run({ d1: { agentStatus: 'idle', agentName: 'Claude Code' } });
    expect((await result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('sends every pane\'s title, and skips an empty one', async () => {
    const { result, titles } = run({
      d1: { agentStatus: 'idle', agentName: null, title: '✳ 50번째 소수', turnOpen: false },
      d2: { agentStatus: 'idle', agentName: null, title: '', turnOpen: false },
    });
    expect((await result).titles).toBe(1);
    expect(titles).toEqual([['d1', '✳ 50번째 소수']]);
  });

  it('skips a pane it could not read and keeps going', async () => {
    mocks.last.set('d2', 'idle');
    const { result } = run({ d1: null, d2: { agentStatus: 'running', agentName: 'Codex', turnOpen: true } });
    const r = await result;
    expect(r.panes).toBe(1);
    expect(r.statusesCorrected).toBe(1);
  });

  it('changes nothing on a second pass', async () => {
    mocks.last.set('d1', 'idle');
    mocks.last.set('d2', 'running');
    const states: Record<string, DaemonPaneState> = {
      d1: { agentStatus: 'running', agentName: 'Codex', turnOpen: true },
      d2: { agentStatus: 'complete', agentName: 'Claude Code', turnOpen: false },
    };
    expect((await run(states, router).result).statusesCorrected).toBe(2);
    mocks.broadcastMetadataUpdate.mockClear();
    expect((await run(states, router).result).statusesCorrected).toBe(0);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('ends a session that exited in the gap, with its code and signal, and reads no status off the tombstone', async () => {
    mocks.last.set('dead', 'running');
    const tracked = new Map([['dead', '/repo'], ['live', '/repo']]);
    const rows = [
      { id: 'dead', state: 'dead', cwd: '/repo', exitCode: 0, exitSignal: 15 },
      { id: 'live', state: 'attached', cwd: '/repo' },
    ];
    const states = {
      dead: { agentStatus: 'running' as const, agentName: 'Claude Code', title: 'stale', turnOpen: true },
      live: { agentStatus: 'idle' as const, agentName: null, turnOpen: false },
    };
    const first = run(states, router, { rows, tracked });
    const r = await first.result;
    expect(first.died).toEqual([['dead', 0, 15]]);
    expect(r.deaths).toBe(1);
    expect(first.read).toEqual(['live']);
    expect(first.titles).toEqual([]);
    expect(statuses()).toEqual([]);

    // Its died listeners dropped it: the next pass leaves it alone.
    const second = run(states, router, { rows, tracked });
    expect((await second.result).deaths).toBe(0);
    expect(second.died).toEqual([]);
  });

  it('leaves a tombstone main no longer tracks alone', async () => {
    const { result, died } = run({}, router, {
      rows: [{ id: 'old', state: 'dead', exitCode: 1 }],
    });
    expect((await result).deaths).toBe(0);
    expect(died).toEqual([]);
  });

  it('sends a tracked pane\'s cwd that changed in the gap, once', async () => {
    const tracked = new Map([['d1', '/old'], ['d2', '/same']]);
    const rows = [
      { id: 'd1', state: 'attached', cwd: '/new' },
      { id: 'd2', state: 'attached', cwd: '/same' },
      { id: 'untracked', state: 'attached', cwd: '/elsewhere' },
    ];
    const first = run({}, null, { rows, tracked });
    expect((await first.result).cwds).toBe(1);
    expect(first.cwds).toEqual([['d1', '/new']]);
    const second = run({}, null, { rows, tracked });
    expect((await second.result).cwds).toBe(0);
  });

  it('keeps a live cwd that arrived while the list was in flight', async () => {
    const tracked = new Map([['d1', '/old']]);
    const { result, cwds } = run({}, null, {
      rows: [{ id: 'd1', state: 'attached', cwd: '/listed' }],
      tracked,
      liveCwdDuringList: ['d1', '/newer'],
    });
    expect((await result).cwds).toBe(0);
    expect(cwds).toEqual([]);
    expect(tracked.get('d1')).toBe('/newer');
  });

  it('does not read a code-0 exit from an older daemon, which keeps no signal, as a clean exit', async () => {
    const { result, died } = run({}, null, {
      rows: [
        { id: 'old-daemon', state: 'dead', exitCode: 0 },
        { id: 'new-daemon', state: 'dead', exitCode: 0, exitSignal: null },
      ],
      tracked: new Map([['old-daemon', '/'], ['new-daemon', '/']]),
    });
    await result;
    expect(died).toEqual([['old-daemon', null, undefined], ['new-daemon', 0, undefined]]);
  });

  it('leaves a pane alone that died live while its state was read', async () => {
    mocks.last.set('d1', 'idle');
    let live: ((kind: 'cwd' | 'lifecycle', id: string) => void) | null = null;
    const tracked = new Map([['d1', '/repo']]);
    const titles: string[] = [];
    const result = await resyncAfterResubscribe({
      listSessions: async () => [{ id: 'd1', state: 'attached', cwd: '/repo' }],
      trackedCwd: (id) => tracked.get(id),
      readState: async () => {
        // The live session:died lands meanwhile.
        tracked.delete('d1');
        live?.('lifecycle', 'd1');
        return { agentStatus: 'running', agentName: 'Codex', title: 'stale', turnOpen: true };
      },
      emitDied: vi.fn(),
      emitCwd: vi.fn(),
      onLiveEvent: (listener) => { live = listener; return () => { live = null; }; },
      emitTitle: (_id, title) => { titles.push(title); },
      hookRouter: null,
      win: null,
    });
    expect(result.statusesCorrected).toBe(0);
    expect(titles).toEqual([]);
    expect(statuses()).toEqual([]);
  });

  it('leaves a listed pane to a live death or restart that landed before the list was read', async () => {
    mocks.last.set('alive', 'idle');
    const died = run({ alive: { agentStatus: 'running', agentName: 'Codex', title: 'stale', turnOpen: true } }, null, {
      rows: [{ id: 'alive', state: 'attached', cwd: '/repo' }],
      tracked: new Map([['alive', '/repo']]),
      liveLifecycleDuringList: 'alive',
    });
    expect((await died.result).statusesCorrected).toBe(0);
    expect(died.read).toEqual([]);
    expect(died.titles).toEqual([]);

    // A tombstone listed before a supervised restart reused its id.
    const restarted = run({}, null, {
      rows: [{ id: 'sup', state: 'dead', exitCode: 1, exitSignal: null }],
      tracked: new Map([['sup', '/repo']]),
      liveLifecycleDuringList: 'sup',
    });
    expect((await restarted.result).deaths).toBe(0);
    expect(restarted.died).toEqual([]);
  });
});
