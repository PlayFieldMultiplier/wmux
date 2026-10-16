// After an app restart main has no turn evidence for a reported worker's
// panes (it lived only in memory). The daemon's view of each pane's turn is
// read once, so a worker whose turn the daemon reports closed is stopped on
// the normal window counted from the report; anything the daemon cannot vouch
// for stays not idle, and evidence main sees itself always wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  REPORTED_IDLE_MS,
  ReclaimedWorkers,
  TURN_SEED_ATTEMPTS_MAX,
  createDaemonTurnSeed,
  installWorkerReclaim,
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

function session(): WorkerSessionInfo {
  return { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' } };
}

/** main after a restart, as workerLifecycleHost wires it: the live turn
 *  evidence (empty until a broadcast), the daemon seed, and the merged pane
 *  activity the idle stop reads. */
function restartedMain(read: (id: string) => Promise<DaemonTurnState | null>, opts: { ready?: () => boolean; panes?: () => Array<{ ptyId: string; reportedAt: number }> | null } = {}) {
  const clock = { now: RESTART };
  const live = { status: new Map<string, string>(), turnStart: new Map<string, number>(), turnEnd: new Map<string, number>(), input: new Map<string, number>() };
  const readState = vi.fn(read);
  const seed = createDaemonTurnSeed({
    panes: opts.panes ?? (() => [{ ptyId: 'daemon-1', reportedAt: REPORT }]),
    ready: opts.ready ?? (() => true),
    readState,
    liveEvidence: (id) => live.turnEnd.has(id) || live.turnStart.has(id),
    now: () => clock.now,
  });
  const activity = (id: string): PaneActivity => {
    const seeded = seed.activity(id);
    const status = live.status.get(id);
    const turnStartAt = live.turnStart.get(id);
    const turnEndAt = live.turnEnd.get(id) ?? seeded?.turnEndAt;
    const inputAt = live.input.get(id) ?? seeded?.inputAt;
    return {
      ...(status !== undefined ? { status } : {}),
      ...(turnStartAt !== undefined ? { turnStartAt } : {}),
      ...(turnEndAt !== undefined ? { turnEndAt } : {}),
      ...(inputAt !== undefined ? { inputAt } : {}),
    };
  };
  const idleAt = (at: number, entry: LedgerEntry = reported()): boolean => workerPanesIdle([activity('daemon-1')], entry.updatedAt, at, REPORTED_IDLE_MS);
  return { clock, live, seed, readState, activity, idleAt };
}

/** One reclaim look at `at` (the install catch-up); whether it stopped the worker. */
async function reclaimLook(main: ReturnType<typeof restartedMain>, at: number): Promise<boolean> {
  const store = ReclaimedWorkers.at(path.join(dir, `store-${at}`));
  const entry = reported();
  const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
  const off = installWorkerReclaim({
    onTransition: () => () => undefined,
    allRows: () => [entry],
    row: () => entry,
    store,
    worktreeOf: async () => wt,
    listSessions: async () => [session()],
    stopAgent,
    now: () => at,
    log: () => undefined,
    turnEnded: (e) => main.idleAt(at, e),
    workspacePanes: () => ['daemon-1'],
  });
  await new Promise((r) => setTimeout(r, 20));
  await vi.waitFor(() => expect(store.get(entry.id)?.state ?? 'none').not.toBe('stopping'));
  off();
  const rec = store.get(entry.id);
  if (rec) await store.put(rec);
  return stopAgent.mock.calls.length > 0 && rec?.state === 'stopped';
}

describe('a reported worker after a restart: the daemon reports its turn closed', () => {
  it('is stopped once 5 minutes passed since the report, not 30', async () => {
    const main = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false }));
    // Before the read main knows nothing of the pane: not idle.
    expect(main.idleAt(REPORT + 6 * MIN)).toBe(false);
    await main.seed.pass();
    expect(main.seed.activity('daemon-1')).toEqual({ turnEndAt: REPORT });
    expect(await reclaimLook(main, REPORT + 4 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 5 * MIN + 1)).toBe(true);
  });

  it('a settled result (complete, waiting, error) counts as closed too', async () => {
    for (const agentStatus of ['complete', 'waiting', 'error']) {
      const main = restartedMain(async () => ({ agentStatus, turnOpen: false }));
      await main.seed.pass();
      expect(main.idleAt(REPORT + 5 * MIN)).toBe(true);
    }
  });

  it('a pane typed into before the restart counts its window from that input', async () => {
    const main = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false, keyInputIdleMs: MIN }));
    await main.seed.pass();
    // Typed at RESTART - 1 min = report + 3 min.
    expect(main.seed.activity('daemon-1')).toEqual({ turnEndAt: REPORT, inputAt: RESTART - MIN });
    expect(main.idleAt(REPORT + 7 * MIN)).toBe(false);
    expect(main.idleAt(REPORT + 8 * MIN)).toBe(true);
  });
});

describe('a reported worker after a restart: the daemon reports its turn open', () => {
  it('turnOpen true, a running turn or a prompt waiting is never idle', async () => {
    const states: DaemonTurnState[] = [
      { agentStatus: 'idle', turnOpen: true },
      { agentStatus: 'running', turnOpen: true },
      { agentStatus: 'running', turnOpen: false },
      { agentStatus: 'awaiting_input', turnOpen: false },
    ];
    for (const state of states) {
      const main = restartedMain(async () => state);
      await main.seed.pass();
      expect(main.seed.activity('daemon-1')).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toBe(false);
    }
  });
});

describe('a reported worker after a restart: the daemon cannot say', () => {
  it('no state (no session, a failed or timed-out read) and an older daemon without turnOpen stay not idle, as before', async () => {
    const reads: Array<() => Promise<DaemonTurnState | null>> = [
      async () => null,
      async () => { throw new Error('timeout'); },
      async () => ({ agentStatus: 'idle' }),
      async () => ({ agentStatus: 'complete' }),
    ];
    for (const read of reads) {
      const main = restartedMain(read);
      await main.seed.pass();
      expect(main.seed.activity('daemon-1')).toBeNull();
      expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
      expect(await reclaimLook(main, REPORT + 60 * MIN)).toBe(false);
    }
  });

  it('a read that came back empty is tried again a bounded number of times; one that lands later seeds', async () => {
    let answer: DaemonTurnState | null = null;
    const main = restartedMain(async () => answer);
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX - 1; i++) await main.seed.pass();
    answer = { agentStatus: 'idle', turnOpen: false };
    await main.seed.pass();
    expect(main.seed.activity('daemon-1')).toEqual({ turnEndAt: REPORT });
    // Seeded: not read again.
    await main.seed.pass();
    expect(main.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX);
    const gaveUp = restartedMain(async () => null);
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 2; i++) await gaveUp.seed.pass();
    expect(gaveUp.readState).toHaveBeenCalledTimes(TURN_SEED_ATTEMPTS_MAX);
  });

  it('reads nothing while the daemon is not connected or the workspace tree is not known, and counts no attempt', async () => {
    let ready = false;
    let tree: Array<{ ptyId: string; reportedAt: number }> | null = null;
    const main = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false }), { ready: () => ready, panes: () => tree });
    await main.seed.pass();
    tree = [{ ptyId: 'daemon-1', reportedAt: REPORT }];
    for (let i = 0; i < TURN_SEED_ATTEMPTS_MAX + 1; i++) await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    ready = true;
    await main.seed.pass();
    expect(main.seed.activity('daemon-1')).toEqual({ turnEndAt: REPORT });
    // A pane that is no longer a reported worker's keeps no seed.
    tree = [];
    await main.seed.pass();
    expect(main.seed.activity('daemon-1')).toBeNull();
  });
});

describe('a reported worker after a restart: live evidence wins over the daemon read', () => {
  it('a live hook turn start after the read keeps the worker until its own turn end, counted from that end', async () => {
    const main = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false }));
    await main.seed.pass();
    // The owner prompts the worker after the restart.
    main.live.turnStart.set('daemon-1', RESTART + MIN);
    main.live.status.set('daemon-1', 'running');
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
    expect(await reclaimLook(main, REPORT + 60 * MIN)).toBe(false);
    // Its turn ends live: the window runs from that end.
    main.live.turnEnd.set('daemon-1', RESTART + 2 * MIN);
    main.live.status.set('daemon-1', 'complete');
    expect(main.idleAt(RESTART + 6 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 7 * MIN)).toBe(true);
  });

  it('live evidence that arrives while the read is out leaves the pane unseeded', async () => {
    let release: (s: DaemonTurnState) => void = () => undefined;
    const main = restartedMain(() => new Promise<DaemonTurnState>((resolve) => { release = resolve; }));
    const pass = main.seed.pass();
    await vi.waitFor(() => expect(main.readState).toHaveBeenCalled());
    // A hook turn start lands before the daemon's answer.
    main.live.turnStart.set('daemon-1', RESTART + 1);
    main.live.status.set('daemon-1', 'running');
    release({ agentStatus: 'idle', turnOpen: false });
    await pass;
    expect(main.seed.activity('daemon-1')).toBeNull();
    expect(main.idleAt(REPORT + 60 * MIN)).toBe(false);
  });

  it('a pane main already has a turn end for is not read; a live byte-rate running status keeps a seeded pane', async () => {
    const main = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false }));
    main.live.turnEnd.set('daemon-1', RESTART);
    await main.seed.pass();
    expect(main.readState).not.toHaveBeenCalled();
    expect(main.idleAt(RESTART + 4 * MIN)).toBe(false);
    expect(main.idleAt(RESTART + 5 * MIN)).toBe(true);
    const busy = restartedMain(async () => ({ agentStatus: 'idle', turnOpen: false }));
    await busy.seed.pass();
    busy.live.status.set('daemon-1', 'running');
    expect(busy.idleAt(REPORT + 60 * MIN)).toBe(false);
  });
});
