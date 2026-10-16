// A reported bot task's idle stop looks at and stops only its own worker
// panes (a pane of its workspace whose agent runs), never a shell there. After
// an app restart main has no turn evidence for them (it lived only in
// memory): the daemon's view of each worker pane's turn is read, so a worker
// whose turn the daemon reports closed is stopped on the normal window
// counted from its last result (never before the report); anything the
// daemon cannot vouch for stays not idle, and evidence main sees itself
// always wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  REPORTED_IDLE_MS,
  ReclaimedWorkers,
  TURN_SEED_ATTEMPTS_MAX,
  TURN_SEED_OPEN_RECHECK_MS,
  createDaemonTurnSeed,
  installWorkerReclaim,
  mergePaneActivity,
  reportedWorkerPanes,
  taskWorkerPanes,
  workerPanesIdle,
  type DaemonTurnState,
  type PaneActivity,
  type WorkerSessionInfo,
} from '../workerReclaim';

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';
const MIN = 60_000;
/** When the task was reported for review. */
const REPORT = 10 * MIN;
/** When main started again (the restart). */
const RESTART = REPORT + 4 * MIN;
const WORKER = 'daemon-1';
const SHELL = 'daemon-2';
/** The daemon's answer for a worker pane whose turn is over. */
const CLOSED: DaemonTurnState = { agentStatus: 'idle', turnOpen: false, hookReports: true };

function reported(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'delta',
    status: 'review_requested', rev: 3, updatedAt: REPORT, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-seed-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

/** The worker's pane: its claude runs. */
function workerSession(): WorkerSessionInfo {
  return { id: WORKER, pid: 10, spawnCwd: wt, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' } };
}
/** A plain shell opened in the same workspace and folder (the owner's). */
function shellSession(): WorkerSessionInfo {
  return { id: SHELL, pid: 11, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
}

interface MainOpts {
  ready?: () => boolean;
  /** The task workspace's panes (null: the tree is not known yet). */
  panes?: () => string[] | null;
  sessions?: () => WorkerSessionInfo[];
  recorded?: string[];
}

/** main after a restart, wired as workerLifecycleHost wires it: main's own
 *  turn evidence (empty until a broadcast), the seed, and the same pure
 *  pieces the host uses (mergePaneActivity, reportedWorkerPanes). */
function restartedMain(read: (id: string) => Promise<DaemonTurnState | null>, opts: MainOpts = {}) {
  const clock = { now: RESTART };
  const live = { status: new Map<string, string>(), turnStart: new Map<string, number>(), turnEnd: new Map<string, number>(), input: new Map<string, number>() };
  const panes = opts.panes ?? (() => [WORKER, SHELL]);
  const sessions = opts.sessions ?? (() => [workerSession(), shellSession()]);
  const readState = vi.fn(read);
  const seed = createDaemonTurnSeed({
    tasks: () => {
      const p = panes();
      return p ? [{ taskId: reported().id, reportedAt: REPORT, panes: p, recorded: opts.recorded ?? [] }] : null;
    },
    ready: opts.ready ?? (() => true),
    listSessions: async () => sessions(),
    readState,
    liveEvidence: (id) => live.turnEnd.has(id) || live.turnStart.has(id),
    now: () => clock.now,
  });
  const activity = (id: string): PaneActivity => {
    const status = live.status.get(id);
    const turnStartAt = live.turnStart.get(id);
    const turnEndAt = live.turnEnd.get(id);
    const inputAt = live.input.get(id);
    return mergePaneActivity({
      ...(status !== undefined ? { status } : {}),
      ...(turnStartAt !== undefined ? { turnStartAt } : {}),
      ...(turnEndAt !== undefined ? { turnEndAt } : {}),
      ...(inputAt !== undefined ? { inputAt } : {}),
    }, seed.activity(id));
  };
  const ownPanes = (entry: LedgerEntry): string[] | null => reportedWorkerPanes(seed.workerPanes(entry.id), panes());
  const idleAt = (at: number, entry: LedgerEntry = reported()): boolean => {
    const own = ownPanes(entry);
    return !!own && workerPanesIdle(own.map(activity), entry.updatedAt, at, REPORTED_IDLE_MS);
  };
  return { clock, live, seed, readState, activity, idleAt, ownPanes, sessions };
}

/** One reclaim look at `at` (the install catch-up): the panes it stopped. */
async function reclaimLook(main: ReturnType<typeof restartedMain>, at: number): Promise<string[]> {
  const store = ReclaimedWorkers.at(path.join(dir, `store-${at}-${Math.random()}`));
  const entry = reported();
  const stopAgent = vi.fn<(id: string) => Promise<{ ok: boolean; stopped: boolean }>>(async () => ({ ok: true, stopped: true }));
  const off = installWorkerReclaim({
    onTransition: () => () => undefined,
    allRows: () => [entry],
    row: () => entry,
    store,
    worktreeOf: async () => wt,
    listSessions: async () => main.sessions(),
    stopAgent,
    now: () => at,
    log: () => undefined,
    turnEnded: (e) => main.idleAt(at, e),
    reportedPanes: main.ownPanes,
    workspacePanes: () => [WORKER, SHELL],
  });
  await new Promise((r) => setTimeout(r, 20));
  await vi.waitFor(() => expect(store.get(entry.id)?.state ?? 'none').not.toBe('stopping'));
  off();
  const rec = store.get(entry.id);
  if (rec) await store.put(rec);
  return stopAgent.mock.calls.map((c) => c[0]);
}

describe('a reported task\'s own worker pane', () => {
  it('taskWorkerPanes: a pane whose agent runs, the recorded one first; never a plain shell', () => {
    const third: WorkerSessionInfo = { ...workerSession(), id: 'daemon-3' };
    expect(taskWorkerPanes([WORKER, SHELL], [], [workerSession(), shellSession()])).toEqual([WORKER]);
    expect(taskWorkerPanes([WORKER, SHELL, 'daemon-3'], ['daemon-3'], [workerSession(), shellSession(), third])).toEqual(['daemon-3']);
    // A recorded pane whose agent no longer runs is no worker pane.
    expect(taskWorkerPanes([WORKER, SHELL], [SHELL], [workerSession(), shellSession()])).toEqual([WORKER]);
    expect(taskWorkerPanes([SHELL], [], [shellSession()])).toEqual([]);
    // Not a session the daemon knows.
    expect(taskWorkerPanes([WORKER], [], [])).toEqual([]);
    expect(reportedWorkerPanes(null, [WORKER])).toEqual([]);
    expect(reportedWorkerPanes([WORKER], null)).toBeNull();
    expect(reportedWorkerPanes([WORKER, 'gone'], [WORKER, SHELL])).toEqual([WORKER]);
  });

  it('a worker pane (closed turn) beside a plain shell: stopped on the 5-minute path from its own pane; the shell never counted, never stopped', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    expect(main.seed.workerPanes(reported().id)).toEqual([WORKER]);
    // Only the worker pane is read.
    expect(main.readState.mock.calls.map((c) => c[0])).toEqual([WORKER]);
    expect(main.seed.activity(SHELL)).toBeNull();
    expect(await reclaimLook(main, REPORT + 4 * MIN)).toEqual([]);
    expect(await reclaimLook(main, REPORT + 5 * MIN + 1)).toEqual([WORKER]);
  });

  it('a worker pane that cannot be identified (no agent runs in any pane) is not idle and nothing is stopped', async () => {
    const main = restartedMain(async () => CLOSED, { sessions: () => [{ ...workerSession(), agentProcessAlive: false }, shellSession()] });
    await main.seed.pass();
    expect(main.seed.workerPanes(reported().id)).toBeNull();
    expect(main.readState).not.toHaveBeenCalled();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    // Before any pass (the daemon not read yet) the same.
    const fresh = restartedMain(async () => CLOSED);
    expect(fresh.idleAt(REPORT + 60 * MIN)).toBe(false);
  });

  it('live, the shell pane never holds the worker either: only the worker pane\'s own turn end counts', async () => {
    const main = restartedMain(async () => CLOSED);
    main.live.turnEnd.set(WORKER, RESTART);
    main.live.status.set(WORKER, 'complete');
    await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    expect(main.idleAt(RESTART + 5 * MIN)).toBe(true);
    expect(await reclaimLook(main, RESTART + 5 * MIN)).toEqual([WORKER]);
  });
});

describe('after a restart: the daemon reports the worker\'s turn closed', () => {
  it('is stopped once 5 minutes passed since the report, not 30', async () => {
    const main = restartedMain(async () => CLOSED, { panes: () => [WORKER] });
    // Before the read main knows nothing of the pane: not idle.
    expect(main.idleAt(REPORT + 6 * MIN)).toBe(false);
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    expect(await reclaimLook(main, REPORT + 4 * MIN)).toEqual([]);
    expect(await reclaimLook(main, REPORT + 5 * MIN + 1)).toEqual([WORKER]);
  });

  it('a result that settled after the report (the worker kept working) counts its window from that result', async () => {
    // The owner prompted the worker after its report; that turn ended 30 s before the restart.
    const main = restartedMain(async () => ({ ...CLOSED, settledAgoMs: 30_000 }));
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: RESTART - 30_000 });
    expect(main.idleAt(RESTART + 4 * MIN)).toBe(false);
    expect(main.idleAt(RESTART - 30_000 + 5 * MIN)).toBe(true);
    // A result older than the report: the report is the floor.
    const older = restartedMain(async () => ({ ...CLOSED, settledAgoMs: 60 * MIN }));
    await older.seed.pass();
    expect(older.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
  });

  it('a settled result (complete, waiting, error) counts as closed too', async () => {
    for (const agentStatus of ['complete', 'waiting', 'error']) {
      const main = restartedMain(async () => ({ ...CLOSED, agentStatus }));
      await main.seed.pass();
      expect(main.idleAt(REPORT + 5 * MIN)).toBe(true);
    }
  });

  it('a pane typed into before the restart counts its window from that input', async () => {
    const main = restartedMain(async () => ({ ...CLOSED, keyInputIdleMs: MIN }));
    await main.seed.pass();
    // Typed at RESTART - 1 min = report + 3 min.
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(main.idleAt(REPORT + 7 * MIN)).toBe(false);
    expect(main.idleAt(REPORT + 8 * MIN)).toBe(true);
  });
});

describe('after a restart: the daemon reports the worker\'s turn open', () => {
  it('turnOpen true, a running turn, a prompt waiting or no hook seen is never idle, and is read again later', async () => {
    const states: DaemonTurnState[] = [
      { agentStatus: 'idle', turnOpen: true, hookReports: true },
      { agentStatus: 'running', turnOpen: true, hookReports: true },
      { agentStatus: 'running', turnOpen: false, hookReports: true },
      { agentStatus: 'awaiting_input', turnOpen: false, hookReports: true },
      { agentStatus: 'idle', turnOpen: false, hookReports: false },
      { agentStatus: 'idle', turnOpen: false },
    ];
    for (const state of states) {
      const main = restartedMain(async () => state);
      await main.seed.pass();
      expect(main.seed.activity(WORKER)).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    }
    // Read again on the slower cadence, never given up on.
    let answer: DaemonTurnState = { agentStatus: 'running', turnOpen: true, hookReports: true };
    const main = restartedMain(async () => answer);
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 2; i++) await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(1);
    answer = CLOSED;
    main.clock.now += TURN_SEED_OPEN_RECHECK_MS;
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(2);
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
  });
});

describe('after a restart: the daemon cannot say', () => {
  it('no state (no session, a failed or timed-out read) and an older daemon without turnOpen stay not idle, as before', async () => {
    const reads: Array<() => Promise<DaemonTurnState | null>> = [
      async () => null,
      async () => { throw new Error('timeout'); },
      async () => ({ agentStatus: 'idle', hookReports: true }),
      async () => ({ agentStatus: 'complete' }),
    ];
    for (const read of reads) {
      const main = restartedMain(read);
      await main.seed.pass();
      expect(main.seed.activity(WORKER)).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    }
  });

  it('a read that came back empty is tried again a bounded number of times; one that lands later seeds', async () => {
    let answer: DaemonTurnState | null = null;
    const main = restartedMain(async () => answer);
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX - 1; i++) await main.seed.pass();
    answer = CLOSED;
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    // Seeded: not read again.
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX);
    const gaveUp = restartedMain(async () => null);
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 2; i++) await gaveUp.seed.pass();
    expect(gaveUp.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX);
  });

  it('a read lost to a disconnect is not counted, and a reconnect starts the count afresh', async () => {
    let ready = true;
    let answer: DaemonTurnState | null = null;
    const main = restartedMain(async () => {
      ready = false;
      return answer;
    }, { ready: () => ready });
    // Every read drops the connection: none is counted.
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 2; i++) {
      ready = true;
      await main.seed.pass();
    }
    expect(main.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX + 2);
    // Reads that came back empty while connected use up the count...
    const flaky = restartedMain(async () => null, { ready: () => ready });
    ready = true;
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 1; i++) await flaky.seed.pass();
    expect(flaky.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX);
    // ...until the daemon disconnects and connects again.
    ready = false;
    await flaky.seed.pass();
    ready = true;
    await flaky.seed.pass();
    expect(flaky.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX + 1);
    // The connection holds again and the daemon answers: seeded.
    answer = CLOSED;
    ready = true;
    const steady = restartedMain(async () => answer, { ready: () => ready });
    await steady.seed.pass();
    expect(steady.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
  });

  it('reads nothing while the daemon is not connected or the workspace tree is not known', async () => {
    let ready = false;
    let tree: string[] | null = null;
    const main = restartedMain(async () => CLOSED, { ready: () => ready, panes: () => tree });
    await main.seed.pass();
    tree = [WORKER, SHELL];
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 1; i++) await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    ready = true;
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toEqual({ turnEndAt: REPORT });
    // A pane that is no longer a reported worker's keeps no seed.
    tree = [];
    await main.seed.pass();
    expect(main.seed.activity(WORKER)).toBeNull();
    expect(main.seed.workerPanes(reported().id)).toBeNull();
  });
});

describe('after a restart: live evidence wins over the daemon read', () => {
  it('mergePaneActivity: a live turn end replaces the seeded one, the later input counts', () => {
    const seeded = { turnEndAt: REPORT, inputAt: RESTART - MIN };
    expect(mergePaneActivity({}, seeded)).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(mergePaneActivity({ turnEndAt: RESTART + MIN, inputAt: RESTART + 2 * MIN, status: 'complete' }, seeded))
      .toEqual({ turnEndAt: RESTART + MIN, inputAt: RESTART + 2 * MIN, status: 'complete' });
    expect(mergePaneActivity({ turnStartAt: RESTART }, null)).toEqual({ turnStartAt: RESTART });
  });

  it('live input after the restart beats the seeded input', async () => {
    const main = restartedMain(async () => ({ ...CLOSED, keyInputIdleMs: 2 * MIN }));
    await main.seed.pass();
    main.live.input.set(WORKER, RESTART + 3 * MIN);
    expect(main.activity(WORKER).inputAt).toBe(RESTART + 3 * MIN);
    expect(main.idleAt(RESTART + 7 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 8 * MIN)).toBe(true);
  });

  it('a live hook turn start after the read keeps the worker until its own turn end, counted from that end', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    // The owner prompts the worker after the restart.
    main.live.turnStart.set(WORKER, RESTART + MIN);
    main.live.status.set(WORKER, 'running');
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toEqual([]);
    // Its turn ends live: the window runs from that end.
    main.live.turnEnd.set(WORKER, RESTART + 2 * MIN);
    main.live.status.set(WORKER, 'complete');
    expect(main.idleAt(RESTART + 6 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 7 * MIN)).toBe(true);
  });

  it('live evidence that arrives while the read is out leaves the pane unseeded', async () => {
    let release: (s: DaemonTurnState) => void = () => undefined;
    const main = restartedMain(() => new Promise<DaemonTurnState>((resolve) => { release = resolve; }));
    const pass = main.seed.pass();
    await vi.waitFor(() => expect(main.readState).toHaveBeenCalled());
    // A hook turn start lands before the daemon's answer.
    main.live.turnStart.set(WORKER, RESTART + 1);
    main.live.status.set(WORKER, 'running');
    release(CLOSED);
    await pass;
    expect(main.seed.activity(WORKER)).toBeNull();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
  });

  it('a live byte-rate running status keeps a seeded pane', async () => {
    const main = restartedMain(async () => CLOSED);
    await main.seed.pass();
    main.live.status.set(WORKER, 'running');
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
  });
});
