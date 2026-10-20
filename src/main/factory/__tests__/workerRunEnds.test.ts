// A bot's worker time runs until its worker stopped: a run ends once its
// task holds nothing in the holder set, not when its row ends
// (workerRunEnds.ts).

import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { emptyUsage, recordWorkerStart, recordWorkerStateChange, workerHoursDay, type BotUsage } from '../budget';
import { computeHolders, type HolderRecord, type HolderSnapshot, type LiveHolders } from '../workerHolders';
import { endRunsOfEndedRows, endRunsOfGoneWorkers, type RunEndPorts } from '../workerRunEnds';

const NOW = 10_000_000_000;
const BOT = 'bot-0000000a';
const OWNER = 'ws-owner';

function row(id: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1,
    id,
    taskWorkspaceId: `ws-${id}`,
    ownerWorkspaceId: OWNER,
    title: id,
    status: 'working',
    rev: 3,
    updatedAt: NOW - 10 * 60_000,
    updatedBy: { kind: 'worker', workspaceId: `ws-${id}` },
    dispatch: { origin: { kind: 'bot', botId: BOT } },
    ...over,
  };
}

function record(taskId: string, over: Partial<HolderRecord> = {}): HolderRecord {
  return { taskId, botId: BOT, ownerWorkspaceId: OWNER, taskWorkspaceId: `ws-${taskId}`, title: taskId, state: 'stopped', ended: 'reported', at: NOW, ...over };
}

/** The holder set as of `now`: the rows' workspaces open with one pane each,
 *  a good read a few seconds old. */
function holders(rows: LedgerEntry[], over: Partial<HolderSnapshot> = {}): LiveHolders {
  const now = over.now ?? NOW;
  const snap: HolderSnapshot = {
    now,
    rows,
    reclaimable: new Set(),
    catchupMs: 24 * 3_600_000,
    workspaces: new Set(rows.map((r) => r.taskWorkspaceId)),
    ptys: new Map(rows.map((r) => [r.taskWorkspaceId, [`p-${r.id}`]])),
    stamps: new Map(rows.map((r) => [r.taskWorkspaceId, { owner: OWNER }])),
    read: 'ok',
    readAt: now - 5_000,
    idle: new Set(),
    busy: new Set(),
    agentSeen: new Set(),
    gone: new Set(),
    records: [],
    verdicted: new Set(),
    taskOfWorkspace: () => null,
    taskOfPane: () => null,
    launchAt: () => undefined,
    launchOf: () => null,
    reservations: [],
    grants: [],
    heldWorkspaces: [],
    ...over,
  };
  return { holders: computeHolders(snap), workspacesKnown: snap.workspaces !== null, readOk: snap.read === 'ok', ...(snap.readAt !== undefined ? { readAt: snap.readAt } : {}) };
}

function rig(rows: () => LedgerEntry[]) {
  const usage: BotUsage = emptyUsage();
  const ports: RunEndPorts = {
    bots: () => [BOT],
    usageOf: () => usage,
    mutateUsage: (_id, fn) => fn(usage),
    row: (taskId) => rows().find((r) => r.id === taskId) ?? null,
    stoppedAt: (taskId) => stops.get(taskId),
    launchedAt: (taskId) => launched.get(taskId),
  };
  const stops = new Map<string, number>();
  const launched = new Map<string, number>();
  return { usage, ports, stops, launched };
}

describe('endRunsOfFreeTasks', () => {
  it('a reported worker whose agent stops 30 s after its report counts those 30 s', () => {
    let rows = [row('t', { status: 'review_requested' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 60_000);
    // Reported: its agent still runs.
    expect(endRunsOfGoneWorkers(ports, holders(rows, { agentSeen: new Set(['ws-t']) }), NOW)).toBe(0);
    expect(usage.workers[0].endedAt).toBeUndefined();
    // 30 s later its idle stop is recorded and a read sees no agent.
    rows = [row('t', { status: 'review_requested' })];
    const later = holders(rows, { now: NOW + 30_000, records: [record('t', { at: NOW + 30_000 })], idle: new Set(['ws-t']) });
    expect(endRunsOfGoneWorkers(ports, later, NOW + 30_000)).toBe(1);
    expect(usage.workers[0].endedAt).toBe(NOW + 30_000);
    expect(workerHoursDay(usage, NOW + 3_600_000)).toBeCloseTo(90_000 / 3_600_000, 9);
  });

  it('a worker whose agent is already gone ends its run at the first look, its row open or ended', () => {
    const rows = [row('open'), row('ended', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 'open', NOW - 60_000);
    recordWorkerStart(usage, 'ended', NOW - 60_000);
    // The open row's panes run no agent; the ended row's agent is known gone.
    const look = holders(rows, { idle: new Set(['ws-open']), gone: new Set(['ended']) });
    expect(endRunsOfGoneWorkers(ports, look, NOW)).toBe(2);
    expect(usage.workers.map((w) => w.endedAt)).toEqual([NOW, NOW]);
  });

  it('a run ends once: the reclaim\'s stop ends it, and a later look moves nothing', () => {
    const rows = [row('t', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 60_000);
    recordWorkerStateChange(usage, 't', 'stopping', 'stopped', NOW);
    const look = holders(rows, { now: NOW + 5_000, records: [record('t', { ended: 'completed' })] });
    expect(endRunsOfGoneWorkers(ports, look, NOW + 5_000)).toBe(0);
    expect(usage.workers).toEqual([{ taskId: 't', startedAt: NOW - 60_000, endedAt: NOW }]);
  });

  it('keeps a run open while its task may still run, and for a task with no row yet', () => {
    const rows = [row('running'), row('unknown', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    for (const id of ['running', 'unknown', 'booking']) recordWorkerStart(usage, id, NOW - 60_000);
    // `running`: its agent seen; `unknown`: an ended task not known gone
    // (held); `booking`: a fan-out whose row is not registered yet.
    const look = holders(rows, { agentSeen: new Set(['ws-running']) });
    expect(endRunsOfGoneWorkers(ports, look, NOW)).toBe(0);
    expect(usage.workers.every((w) => w.endedAt === undefined)).toBe(true);
    // A task no holder names whose row ended: its run ends.
    const gone = rig(() => [row('old', { status: 'cancelled' })]);
    recordWorkerStart(gone.usage, 'old', NOW - 60_000);
    expect(endRunsOfGoneWorkers(gone.ports, { holders: [], workspacesKnown: true, readOk: true }, NOW)).toBe(1);
  });

  it('before the open workspaces and a read are known (a start-up), a task no holder names keeps its run', () => {
    const { usage, ports } = rig(() => [row('old', { status: 'cancelled' })]);
    recordWorkerStart(usage, 'old', NOW - 60_000);
    expect(endRunsOfGoneWorkers(ports, { holders: [], workspacesKnown: false, readOk: false }, NOW)).toBe(0);
    expect(endRunsOfGoneWorkers(ports, { holders: [], workspacesKnown: true, readOk: false }, NOW)).toBe(0);
    expect(usage.workers[0].endedAt).toBeUndefined();
  });

  it('a verify verdict frees the slot but keeps the run while its agent runs', () => {
    const rows = [row('v', { status: 'review_requested', dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'verify' } })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 'v', NOW - 60_000);
    const running = holders(rows, { verdicted: new Set(['v']), agentSeen: new Set(['ws-v']) });
    expect(running.holders[0]).toMatchObject({ state: 'free', why: 'verdicted' });
    expect(endRunsOfGoneWorkers(ports, running, NOW)).toBe(0);
    // Its agent seen gone: the run ends.
    expect(endRunsOfGoneWorkers(ports, holders(rows, { verdicted: new Set(['v']), idle: new Set(['ws-v']) }), NOW + 1_000)).toBe(1);
    expect(usage.workers[0].endedAt).toBe(NOW + 1_000);
  });

  it('a reported task whose last terminal closed, its workspace kept, ends its run while it still holds its slot', () => {
    const rows = [row('t', { status: 'review_requested' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 60_000);
    const look = holders(rows, { ptys: new Map([['ws-t', []]]) });
    expect(look.holders[0]).toMatchObject({ state: 'held', why: 'running' });
    expect(endRunsOfGoneWorkers(ports, look, NOW)).toBe(1);
    // Not before a read: a pane may not be listed yet.
    const before = rig(() => rows);
    recordWorkerStart(before.usage, 't', NOW - 60_000);
    expect(endRunsOfGoneWorkers(before.ports, holders(rows, { ptys: new Map([['ws-t', []]]), read: 'stale' }), NOW)).toBe(0);
  });

  it('a task no holder names any more ends its run at its durable stop\'s time', () => {
    const r = rig(() => [row('old', { status: 'completed' })]);
    recordWorkerStart(r.usage, 'old', NOW - 31 * 3_600_000);
    r.stops.set('old', NOW - 30 * 3_600_000);
    expect(endRunsOfGoneWorkers(r.ports, { holders: [], workspacesKnown: true, readOk: true }, NOW)).toBe(1);
    expect(r.usage.workers[0].endedAt).toBe(NOW - 30 * 3_600_000);
    expect(workerHoursDay(r.usage, NOW)).toBe(0);
  });

  it('a worker relaunched in its pane after its agent exited runs on its bot\'s time again, from the read that saw it', () => {
    let rows = [row('t')];
    const r = rig(() => rows);
    recordWorkerStart(r.usage, 't', NOW - 3_600_000);
    // Its agent exits: the run ends.
    expect(endRunsOfGoneWorkers(r.ports, holders(rows, { idle: new Set(['ws-t']) }), NOW)).toBe(1);
    // A launch line typed again in its pane; a read after it sees its agent.
    r.launched.set('t', NOW + 60_000);
    rows = [row('t')];
    const running = holders(rows, { now: NOW + 120_000, readAt: NOW + 90_000, agentTasks: new Map([['t', BOT]]), launchAt: () => NOW + 60_000 });
    expect(endRunsOfGoneWorkers(r.ports, running, NOW + 120_000)).toBe(1);
    expect(r.usage.workers.map((w) => [w.startedAt, w.endedAt])).toEqual([[NOW - 3_600_000, NOW], [NOW + 90_000, undefined]]);
    // Looking again opens nothing more; its stop ends the new run.
    expect(endRunsOfGoneWorkers(r.ports, running, NOW + 130_000)).toBe(0);
    const stopped = holders(rows, { now: NOW + 600_000, records: [record('t', { ended: 'reported', at: NOW + 600_000, endRev: 3 })], launchAt: () => NOW + 60_000 });
    expect(endRunsOfGoneWorkers(r.ports, stopped, NOW + 600_000)).toBe(1);
    expect(workerHoursDay(r.usage, NOW + 3_600_000)).toBeCloseTo(1 + 510_000 / 3_600_000, 9);
    // A read older than the last run's end opens nothing.
    expect(endRunsOfGoneWorkers(r.ports, running, NOW + 700_000)).toBe(0);
  });

  it('a relaunch long after its last run (older runs pruned) runs on its bot\'s time too', () => {
    const rows = [row('t')];
    const r = rig(() => rows);
    // No run of the task kept.
    r.launched.set('t', NOW - 60_000);
    expect(endRunsOfGoneWorkers(r.ports, holders(rows, { agentTasks: new Map([['t', BOT]]), launchAt: () => NOW - 60_000 }), NOW)).toBe(1);
    expect(r.usage.workers).toEqual([{ taskId: 't', startedAt: NOW - 5_000 }]);
  });

  it('a launch line staged in its pane and not run yet starts no run', () => {
    const rows = [row('t')];
    const r = rig(() => rows);
    recordWorkerStart(r.usage, 't', NOW - 3_600_000);
    expect(endRunsOfGoneWorkers(r.ports, holders(rows, { idle: new Set(['ws-t']) }), NOW)).toBe(1);
    // Staged: the launch is recorded and the pane holds (its grace), but no
    // read sees its agent.
    r.launched.set('t', NOW + 10_000);
    const staged = holders(rows, { now: NOW + 20_000, readAt: NOW + 15_000, launchAt: () => NOW + 10_000 });
    expect(staged.holders[0]).toMatchObject({ state: 'held', why: 'starting' });
    expect(endRunsOfGoneWorkers(r.ports, staged, NOW + 20_000)).toBe(0);
    expect(r.usage.workers).toHaveLength(1);
  });

  it('another agent in the task\'s workspace (an owner\'s split) opens no run for a staged relaunch', () => {
    const rows = [row('t')];
    const r = rig(() => rows);
    recordWorkerStart(r.usage, 't', NOW - 3_600_000);
    expect(endRunsOfGoneWorkers(r.ports, holders(rows, { idle: new Set(['ws-t']) }), NOW)).toBe(1);
    r.launched.set('t', NOW + 10_000);
    // The workspace shows an agent, but no pane of the task's worker runs one.
    const split = holders(rows, { now: NOW + 200_000, readAt: NOW + 190_000, agentSeen: new Set(['ws-t']), launchAt: () => NOW + 10_000 });
    expect(split.holders[0]).toMatchObject({ state: 'held' });
    expect(endRunsOfGoneWorkers(r.ports, split, NOW + 200_000)).toBe(0);
    expect(r.usage.workers).toHaveLength(1);
  });

  it('a stop older than the run it would end is not its stop: the run ends now', () => {
    const r = rig(() => [row('t', { status: 'cancelled' })]);
    recordWorkerStart(r.usage, 't', NOW - 60_000);
    r.stops.set('t', NOW - 3_600_000);
    expect(endRunsOfGoneWorkers(r.ports, { holders: [], workspacesKnown: true, readOk: true }, NOW)).toBe(1);
    expect(r.usage.workers[0].endedAt).toBe(NOW);
  });

  it('a stop recorded while the app was closed ends the run at the stop, not at the next look', () => {
    const rows = [row('t', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 3_600_000);
    // Stopped at NOW; the app looks again six hours later.
    const look = holders(rows, { now: NOW + 6 * 3_600_000, records: [record('t', { ended: 'completed', at: NOW })] });
    expect(endRunsOfGoneWorkers(ports, look, NOW + 6 * 3_600_000)).toBe(1);
    expect(usage.workers[0].endedAt).toBe(NOW);
  });
});

describe('endRunsOfEndedRows', () => {
  it('a lifecycle host that never came up: the rows that ended end their runs, open rows keep theirs', () => {
    const rows = [row('done', { status: 'completed' }), row('open')];
    const r = rig(() => rows);
    recordWorkerStart(r.usage, 'done', NOW - 60_000);
    recordWorkerStart(r.usage, 'open', NOW - 60_000);
    expect(endRunsOfEndedRows(r.ports, NOW)).toBe(1);
    expect(r.usage.workers.map((w) => [w.taskId, w.endedAt])).toEqual([['done', NOW], ['open', undefined]]);
  });
  it('a row that reached review ends its run too, as the row-end callback would have', () => {
    const rows = [row('reviewed', { status: 'review_requested' })];
    const r = rig(() => rows);
    recordWorkerStart(r.usage, 'reviewed', NOW - 60_000);
    expect(endRunsOfEndedRows(r.ports, NOW)).toBe(1);
    expect(r.usage.workers[0].endedAt).toBe(NOW);
  });
});
