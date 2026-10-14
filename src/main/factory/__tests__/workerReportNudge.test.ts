// A bot worker that answered but did not report its task is reminded once,
// then surfaced as needing input; nothing is ever stopped.
import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { UNREPORTED_SUMMARY, installReportNudge, reportNudgeText, type ReportNudgePorts } from '../workerReportNudge';

function row(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'A',
    status: 'working', rev: 1, updatedAt: 1, updatedBy: { kind: 'system', workspaceId: 'daemon' },
    dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } },
    ...over,
  };
}

function setup(entry: LedgerEntry, over: Partial<ReportNudgePorts> = {}) {
  let current: LedgerEntry | null = entry;
  const timers: Array<() => void> = [];
  const submit = vi.fn(async (_ptyId: string, _text: string) => true);
  const update = vi.fn(async () => ({ ok: true as const, entry: current! }));
  const note = vi.fn();
  const nudger = installReportNudge({
    ledger: { findOpenByTaskWorkspace: () => current, get: () => current, update },
    isRunning: () => false,
    submit,
    note,
    setTimer: (fn) => { timers.push(fn); return 0; },
    ...over,
  });
  const stop = (kind = 'agent.stop', extra: Record<string, string> = {}) => nudger.noteLifecycle({ workspaceId: 'ws-task', ptyId: 'pty-1', kind, ...extra });
  const flush = async () => { for (const t of timers.splice(0)) t(); await new Promise((r) => setTimeout(r, 0)); };
  return { stop, flush, submit, update, note, set: (e: LedgerEntry | null) => { current = e; } };
}

describe('report nudge', () => {
  it('reminds the worker once with its task id and rev, then moves an unreported task to input_required', async () => {
    const t = setup(row());
    t.stop();
    await t.flush();
    expect(t.submit).toHaveBeenCalledWith('pty-1', reportNudgeText('wtask-abc-12345678', 1));
    expect(t.submit.mock.calls[0][1]).toContain('wtask-abc-12345678');
    t.stop();
    await t.flush();
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'wtask-abc-12345678', status: 'input_required', expectedRev: 1, summary: UNREPORTED_SUMMARY }));
    t.stop();
    await t.flush();
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing once the worker reported, for a task no bot started, while a turn runs, or on a shell command end', async () => {
    const reported = setup(row());
    reported.stop();
    reported.set(row({ status: 'review_requested', rev: 2 }));
    await reported.flush();
    expect(reported.submit).not.toHaveBeenCalled();

    const pane = setup(row({ dispatch: { origin: { kind: 'pane' } } }));
    pane.stop();
    await pane.flush();
    expect(pane.submit).not.toHaveBeenCalled();

    const busy = setup(row(), { isRunning: () => true });
    busy.stop();
    await busy.flush();
    expect(busy.submit).not.toHaveBeenCalled();

    const shell = setup(row());
    shell.stop('agent.stop', { source: 'osc133' });
    shell.stop('agent.awaiting_input');
    await shell.flush();
    expect(shell.submit).not.toHaveBeenCalled();
  });

  it('a held delivery (someone typing) is tried again at the next turn end and surfaces nothing yet', async () => {
    const t = setup(row());
    t.submit.mockResolvedValueOnce(false);
    t.stop();
    await t.flush();
    t.stop();
    await t.flush();
    expect(t.submit).toHaveBeenCalledTimes(2);
    expect(t.update).not.toHaveBeenCalled();
  });
});

describe('report nudge overlap', () => {
  it('a turn end while the reminder is still being delivered starts no second reminder', async () => {
    let finish: (v: boolean) => void = () => undefined;
    const slow = vi.fn((_ptyId: string, _text: string) => new Promise<boolean>((r) => { finish = r; }));
    const t = setup(row(), { submit: slow });
    t.stop();
    await t.flush();
    t.stop();
    await t.flush();
    finish(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('report nudge escalation retry (review fixes, PR #2164)', () => {
  it('a move to input_required that did not land is tried again at the next turn end', async () => {
    const t = setup(row());
    t.stop();
    await t.flush();
    t.update.mockResolvedValueOnce({ ok: false, error: 'persist_failed', message: 'disk' } as never);
    t.stop();
    await t.flush();
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.note).toHaveBeenCalledTimes(1); // only the reminder card
    t.update.mockRejectedValueOnce(new Error('daemon gone'));
    t.stop();
    await t.flush();
    expect(t.update).toHaveBeenCalledTimes(2);
    t.stop();
    await t.flush();
    expect(t.update).toHaveBeenCalledTimes(3);
    expect(t.note).toHaveBeenCalledTimes(2);
    t.stop();
    await t.flush();
    expect(t.update).toHaveBeenCalledTimes(3);
  });
});
