// Real git/worktree, npm gate, ledger, room and durable wake queue. The
// worker's edits/reports are scripted; no provider or GitHub is contacted.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { LedgerEntry } from '../../../shared/ledger';
import { installBotFanoutWake } from '../../deck/fanoutCallerNotify';
import { TaskGateRunner } from '../../worktask/TaskGateRunner';
import { createHostedLedgerPort } from '../../worktask/ledgerPort';
import { RoomWriter } from '../roomWriter';
import { completeCheckedTask, gateCardNoted, installTaskGate, type TaskGatePorts } from '../taskGate';
import { verifyGateFactId } from '../verifyPreset';
import { WakeQueue, wakeQueuePath } from '../wakeQueue';

it('recovers an interrupted check across restart, then gates a failed task and its repair at their own commits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-repair-'));
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'worker');
  fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let offGate: () => void = () => undefined;
  let offFanout: () => void = () => undefined;
  let queue = new WakeQueue(wakeQueuePath(dir));
  let runner: TaskGateRunner | undefined;
  try {
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Bot lifecycle test');
    git(repo, 'config', 'user.email', 'bot-test@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'bot-repair-fixture', private: true, scripts: { test: 'node check.cjs' } }));
    fs.writeFileSync(path.join(repo, 'check.cjs'), "require('node:assert/strict').equal(require('./answer.cjs'), 42);\n");
    fs.writeFileSync(path.join(repo, 'answer.cjs'), 'module.exports = 0;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base with a failing check');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-b', 'wtask/repair', worktree, 'main');
    fs.writeFileSync(path.join(worktree, 'answer.cjs'), 'module.exports = 41;\n');
    git(worktree, 'commit', '-am', 'first attempt');
    const failedHead = git(worktree, 'rev-parse', 'HEAD');

    let ledger = new TaskLedger({ dir: path.join(dir, 'ledger') });
    const bot: BotProfile = {
      version: 1, id: 'bot-0000000a', workspaceId: 'ws-owner', role: 'lead', name: 'Developer',
      engine: { kind: 'claude-sdk' }, triggers: [], budget: { ...DEFAULT_BOT_BUDGETS.lead },
      repo: { repoKey: 'github.com/test/repo', repoPath: repo }, enabled: true, createdAt: 1, updatedAt: 1,
    };
    await ledger.register({
      id: 'task-repair', taskWorkspaceId: 'ws-worker', ownerWorkspaceId: bot.workspaceId, title: 'repair answer',
      dispatch: { origin: { kind: 'bot', botId: bot.id }, preset: 'default', baseOid: base },
    });
    let probeFailed = false;
    runner = new TaskGateRunner({
      ledger: createHostedLedgerPort(() => ledger),
      // One injected environment error; all git reads, npm processes and
      // gate receipts below use the production runner implementations.
      depsState: () => {
        if (!probeFailed) { probeFailed = true; throw new Error('dependency probe interrupted'); }
        return 'missing'; // zero-dependency fixture: no install needed
      },
    });
    let rooms = new RoomWriter({ dir: path.join(dir, 'rooms') });
    const runGate = vi.fn((input: Parameters<TaskGateRunner['run']>[0]) => (runner as TaskGateRunner).run(input));
    const ports: TaskGatePorts = {
      onTransition: (fn) => ledger.onTransition(fn), ledgerRow: (id) => ledger.get(id),
      openRows: () => ledger.list({ openOnly: true }), allRows: () => ledger.list({}),
      bot: (id) => id === bot.id ? bot : null,
      worktreeOf: async () => worktree, baseRef: async () => 'main', runGate,
      complete: (id) => completeCheckedTask(ledger, id),
      wake: (input) => queue.enqueue(input),
      note: (workspaceId, threadId, title, body, key, notice) => {
        rooms.append({ workspaceId, threadId, title, body, notice, kind: 'fact', actor: { kind: 'system' } }, { clientPostId: key });
      },
      noted: (ws, thread, key) => gateCardNoted((w, match) => rooms.find(w, match), ws, thread, key),
      log: () => undefined,
    };
    const row = (): LedgerEntry => ledger.get('task-repair') as LedgerEntry;
    const report = async (): Promise<void> => {
      const r = await ledger.update({ id: row().id, status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-worker' }, expectedRev: row().rev, summary: 'ready for checking' });
      expect(r.ok).toBe(true);
    };
    const sendBack = async (): Promise<void> => {
      const r = await ledger.update({ id: row().id, status: 'input_required', actor: { kind: 'brain', workspaceId: bot.workspaceId }, expectedRev: row().rev });
      expect(r.ok).toBe(true);
    };
    const gateFacts = (): string[] => queue.list({ botId: bot.id }).filter((i) => i.state !== 'dropped')
      .flatMap((i) => i.reason.kind === 'facts' ? i.reason.factIds.filter((f) => f.startsWith('task.gated:')) : []);
    offFanout = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, ledger);
    offGate = installTaskGate(ports);

    // Report wake is held by the gate; an exception must release it without
    // recording a success or a failure for code that was not tested.
    await report();
    await vi.waitFor(() => expect(gateFacts()).toHaveLength(1), { timeout: 10_000 });
    expect(row().status).toBe('review_requested');
    expect(row().gate).toBeUndefined();
    const interruptedFact = verifyGateFactId(row().id, row().rev);
    expect(gateFacts()).toEqual([interruptedFact]);
    expect(rooms.find(bot.workspaceId, (c) => c.clientPostId === interruptedFact)?.body).toContain('dependency probe interrupted');
    expect(queue.list().flatMap((i) => i.reason.kind === 'facts' ? i.reason.factIds : []).some((f) => f.startsWith('task.review_requested:'))).toBe(false);

    // Recreate the persisted ledger, queue and room. The existing card prevents a
    // repeated gate; its wake keeps the same key and is deduplicated.
    offGate();
    offFanout();
    await queue.flush();
    ledger = new TaskLedger({ dir: path.join(dir, 'ledger') });
    expect(row().status).toBe('review_requested');
    expect(row().gate).toBeUndefined();
    queue = new WakeQueue(wakeQueuePath(dir));
    queue.load();
    rooms = new RoomWriter({ dir: path.join(dir, 'rooms') });
    const wake = vi.fn(ports.wake);
    offFanout = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, ledger);
    offGate = installTaskGate({ ...ports, wake });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(gateFacts()).toEqual([interruptedFact]);

    // A retry actually runs npm test and leaves the broken commit open.
    await sendBack();
    await report();
    await vi.waitFor(() => expect(gateFacts()).toHaveLength(2), { timeout: 10_000 });
    expect(row().status).toBe('review_requested');
    expect(row().gate).toMatchObject({ exitCode: 1, headSha: failedHead, recordedBy: 'system' });
    expect(row().gate?.tail).toContain('41');

    // The worker repairs its worktree; only the new report's successful
    // check completes the task, with evidence pinned to the repaired head.
    await sendBack();
    fs.writeFileSync(path.join(worktree, 'answer.cjs'), 'module.exports = 42;\n');
    git(worktree, 'commit', '-am', 'repair answer');
    const repairedHead = git(worktree, 'rev-parse', 'HEAD');
    await report();
    await vi.waitFor(() => expect(gateFacts()).toHaveLength(3), { timeout: 10_000 });
    expect(row().status).toBe('completed');
    expect(row().gate).toMatchObject({ exitCode: 0, headSha: repairedHead, recordedBy: 'system' });
    expect(repairedHead).not.toBe(failedHead);
    expect(runGate).toHaveBeenCalledTimes(3);
    expect(new Set(gateFacts()).size).toBe(3);
  } finally {
    offGate();
    offFanout();
    runner?.cancel('task-repair');
    await queue.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
