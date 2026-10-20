// A reported worker whose agent is already gone ends its run at once
// (workerRunEnds.ts); one still running, or one a read cannot tell, keeps it.

import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import type { WorkerSessionInfo } from '../workerReclaim';
import { endReportedRunIfAgentGone, type ReportedRunPorts } from '../workerRunEnds';

const BOT = 'bot-0000000a';
const READ_AT = 5_000_000;

function row(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1,
    id: 'wtask-a',
    taskWorkspaceId: 'ws-task',
    ownerWorkspaceId: 'ws-owner',
    title: 'a',
    status: 'review_requested',
    rev: 2,
    updatedAt: 1,
    updatedBy: { kind: 'worker', workspaceId: 'ws-task' },
    dispatch: { origin: { kind: 'bot', botId: BOT } },
    ...over,
  };
}

function ports(sessions: WorkerSessionInfo[] | Error, over: Partial<ReportedRunPorts> = {}) {
  const end = vi.fn();
  const p: ReportedRunPorts = {
    listSessions: async () => {
      if (sessions instanceof Error) throw sessions;
      return sessions;
    },
    row: () => row(),
    recordedSessions: () => [],
    // The worker's own pane, as its bot worker session record names it.
    sessionRecordOf: (id) => (id === 'daemon-w' ? { taskId: 'wtask-a' } : null),
    end,
    now: () => READ_AT,
    ...over,
  };
  return { p, end };
}

const pane = (over: Partial<WorkerSessionInfo> = {}): WorkerSessionInfo => ({ id: 'daemon-w', cwd: '/wt', ...over } as WorkerSessionInfo);

describe('endReportedRunIfAgentGone', () => {
  it('a reported worker whose agent already exited ends its run at the read, at once', async () => {
    const { p, end } = ports([pane({ agentProcessAlive: false })]);
    expect(await endReportedRunIfAgentGone(p, row())).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(BOT, 'wtask-a', READ_AT);
  });

  it('keeps the run while its agent runs, or a read cannot tell', async () => {
    for (const sessions of [[pane({ agentProcessAlive: true })], [pane()], [], new Error('daemon down'), [pane({ id: 'daemon-other', agentProcessAlive: false })]]) {
      const { p, end } = ports(sessions);
      expect(await endReportedRunIfAgentGone(p, row())).toBe(false);
      expect(end).not.toHaveBeenCalled();
    }
  });

  it('leaves a row that moved on during the read, and any row not reported', async () => {
    const moved = ports([pane({ agentProcessAlive: false })], { row: () => row({ status: 'working', rev: 3 }) });
    expect(await endReportedRunIfAgentGone(moved.p, row())).toBe(false);
    const ended = ports([pane({ agentProcessAlive: false })]);
    expect(await endReportedRunIfAgentGone(ended.p, row({ status: 'completed' }))).toBe(false);
    expect(await endReportedRunIfAgentGone(ended.p, row({ dispatch: { origin: { kind: 'pane' } } }))).toBe(false);
    expect(moved.end).not.toHaveBeenCalled();
    expect(ended.end).not.toHaveBeenCalled();
  });
});
