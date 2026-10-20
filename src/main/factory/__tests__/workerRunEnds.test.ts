// A bot's worker time runs until its worker stopped: a run ends once its
// task holds nothing in the holder set, not when its row ends
// (workerRunEnds.ts).

import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { emptyUsage, recordWorkerStart, recordWorkerStateChange, workerHoursDay, type BotUsage } from '../budget';
import { computeHolders, type HolderRecord, type HolderSnapshot } from '../workerHolders';
import { endRunsOfFreeTasks, type RunEndPorts } from '../workerRunEnds';

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
function holders(rows: LedgerEntry[], over: Partial<HolderSnapshot> = {}) {
  const now = over.now ?? NOW;
  return computeHolders({
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
  });
}

function rig(rows: () => LedgerEntry[]) {
  const usage: BotUsage = emptyUsage();
  const ports: RunEndPorts = {
    bots: () => [BOT],
    usageOf: () => usage,
    mutateUsage: (_id, fn) => fn(usage),
    row: (taskId) => rows().find((r) => r.id === taskId) ?? null,
  };
  return { usage, ports };
}

describe('endRunsOfFreeTasks', () => {
  it('a reported worker whose agent stops 30 s after its report counts those 30 s', () => {
    let rows = [row('t', { status: 'review_requested' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 60_000);
    // Reported: its agent still runs.
    expect(endRunsOfFreeTasks(ports, holders(rows, { agentSeen: new Set(['ws-t']) }), NOW)).toBe(0);
    expect(usage.workers[0].endedAt).toBeUndefined();
    // 30 s later its idle stop is recorded and a read sees no agent.
    rows = [row('t', { status: 'review_requested' })];
    const later = holders(rows, { now: NOW + 30_000, records: [record('t', { at: NOW + 30_000 })], idle: new Set(['ws-t']) });
    expect(endRunsOfFreeTasks(ports, later, NOW + 30_000)).toBe(1);
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
    expect(endRunsOfFreeTasks(ports, look, NOW)).toBe(2);
    expect(usage.workers.map((w) => w.endedAt)).toEqual([NOW, NOW]);
  });

  it('a run ends once: the reclaim\'s stop ends it, and a later look moves nothing', () => {
    const rows = [row('t', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    recordWorkerStart(usage, 't', NOW - 60_000);
    recordWorkerStateChange(usage, 't', 'stopping', 'stopped', NOW);
    const look = holders(rows, { now: NOW + 5_000, records: [record('t', { ended: 'completed' })] });
    expect(endRunsOfFreeTasks(ports, look, NOW + 5_000)).toBe(0);
    expect(usage.workers).toEqual([{ taskId: 't', startedAt: NOW - 60_000, endedAt: NOW }]);
  });

  it('keeps a run open while its task may still run, and for a task with no row yet', () => {
    const rows = [row('running'), row('unknown', { status: 'completed' })];
    const { usage, ports } = rig(() => rows);
    for (const id of ['running', 'unknown', 'booking']) recordWorkerStart(usage, id, NOW - 60_000);
    // `running`: its agent seen; `unknown`: an ended task not known gone
    // (held); `booking`: a fan-out whose row is not registered yet.
    const look = holders(rows, { agentSeen: new Set(['ws-running']) });
    expect(endRunsOfFreeTasks(ports, look, NOW)).toBe(0);
    expect(usage.workers.every((w) => w.endedAt === undefined)).toBe(true);
    // A task no holder names whose row ended: its run ends.
    const gone = rig(() => [row('old', { status: 'cancelled' })]);
    recordWorkerStart(gone.usage, 'old', NOW - 60_000);
    expect(endRunsOfFreeTasks(gone.ports, [], NOW)).toBe(1);
  });
});
