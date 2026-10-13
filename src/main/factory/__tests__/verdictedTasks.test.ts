import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskLedger, type LedgerTransition } from '../../../daemon/ledger/TaskLedger';
import type { PrVerdictRecord } from '../../../shared/prVerdict';
import { VerdictedTasks, closeVerifyTask, installVerifyTaskClose } from '../verdictedTasks';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-verdicted-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('VerdictedTasks', () => {
  it('keeps verdicted verify tasks across a restart; an unreadable file reads as none', () => {
    const file = path.join(dir, 'factory', 'verdicted-tasks.json');
    const a = new VerdictedTasks(file);
    a.load();
    a.add('wtask-1');
    a.add('wtask-1');
    const b = new VerdictedTasks(file);
    b.load();
    expect(b.has('wtask-1')).toBe(true);
    expect(b.has('wtask-2')).toBe(false);
    fs.writeFileSync(file, '{broken');
    const c = new VerdictedTasks(file);
    c.load();
    expect(c.has('wtask-1')).toBe(false);
  });
});

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BOT = 'bot-0000000v';

/** A verify task of BOT in workspace ws-v, reported done, with a recorded gate. */
async function verifyTask(ledger: TaskLedger, id: string, opts: { exitCode?: number; botId?: string; preset?: string; report?: boolean } = {}): Promise<void> {
  await ledger.register({
    id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-v', title: 'verify',
    dispatch: { origin: { kind: 'bot', botId: opts.botId ?? BOT }, preset: opts.preset ?? 'verify', checkout: { sha: HEAD, detached: true } },
  });
  const gated = await ledger.recordGate(id, { exitCode: opts.exitCode ?? 0, tail: '', at: 1, command: 'npm test', headSha: HEAD });
  if (!gated.ok) throw new Error(gated.message);
  if (opts.report === false) return;
  const r = await ledger.update({ id, status: 'review_requested', actor: { kind: 'worker', workspaceId: `${id}-ws` }, expectedRev: gated.entry.rev });
  if (!r.ok) throw new Error(r.message);
}

function verdict(taskId: string, v: 'pass' | 'fail', headSha = HEAD, botId: string | null = BOT): PrVerdictRecord {
  return {
    version: 2, repoKey: 'github.com/acme/app', prNumber: 1, headSha, verdict: v,
    principal: { workspaceId: 'ws-v', ...(botId ? { botId } : {}), agent: 'bot:verifier' },
    evidence: { taskId, gateHeadSha: headSha }, summary: 's', at: 1,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('closeVerifyTask', () => {
  it('closes a PASS on a green gate as completed, unforced; a red gate is closed with the forced reason', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-green');
    await verifyTask(ledger, 'wtask-red', { exitCode: 1 });
    const moves: LedgerTransition[] = [];
    ledger.onTransition((t) => moves.push(t));
    expect(await closeVerifyTask(ledger, 'wtask-green', BOT, 'PASS verdict recorded')).toBe(true);
    expect(ledger.get('wtask-green')).toMatchObject({ status: 'completed', updatedBy: { kind: 'brain', workspaceId: 'ws-v' } });
    expect(ledger.get('wtask-green')?.summary ?? '').not.toMatch(/forced/);
    expect(await closeVerifyTask(ledger, 'wtask-red', BOT, 'FAIL verdict recorded')).toBe(true);
    expect(ledger.get('wtask-red')?.summary).toMatch(/\[forced: FAIL verdict recorded\]/);
    expect(moves.map((t) => [t.entry.id, t.from, t.to])).toEqual([['wtask-green', 'review_requested', 'completed'], ['wtask-red', 'review_requested', 'completed']]);
    // Closed already: true, no second move.
    expect(await closeVerifyTask(ledger, 'wtask-green', BOT, 'again')).toBe(true);
    expect(moves).toHaveLength(2);
    expect(ledger.list({ openOnly: true })).toEqual([]);
  });

  it('leaves alone another bot\'s task, a task of another preset, one not reported, and an unknown id', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-other', { botId: 'bot-0000000x' });
    await verifyTask(ledger, 'wtask-default', { preset: 'default' });
    await verifyTask(ledger, 'wtask-working', { report: false });
    for (const id of ['wtask-other', 'wtask-default', 'wtask-working', 'wtask-none']) {
      expect(await closeVerifyTask(ledger, id, BOT, 'x'), id).toBe(false);
    }
    expect(ledger.list({ openOnly: true }).map((e) => e.status).sort()).toEqual(['review_requested', 'review_requested', 'working']);
  });

  it('retries once when the row moved between the read and the write; never throws', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-1');
    let first = true;
    const racy = {
      get: (id: string) => ledger.get(id),
      update: async (input: Parameters<TaskLedger['update']>[0]) => {
        if (first) {
          first = false;
          return { ok: false as const, error: 'stale_rev' as const, message: 'moved' };
        }
        return ledger.update(input);
      },
    };
    expect(await closeVerifyTask(racy, 'wtask-1', BOT, 'x')).toBe(true);
    const broken = { get: () => { throw new Error('boom'); }, update: ledger.update.bind(ledger) };
    expect(await closeVerifyTask(broken, 'wtask-1', BOT, 'x')).toBe(false);
  });
});

describe('installVerifyTaskClose', () => {
  function hook() {
    const fns = new Set<(r: PrVerdictRecord) => void>();
    return {
      onRecorded: (fn: (r: PrVerdictRecord) => void) => { fns.add(fn); return () => fns.delete(fn); },
      record: (r: PrVerdictRecord) => { for (const fn of fns) fn(r); },
      count: () => fns.size,
    };
  }

  it('a recorded PASS and a recorded FAIL each close their verify task', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-pass');
    await verifyTask(ledger, 'wtask-fail', { exitCode: 2 });
    const verdicted = new VerdictedTasks(path.join(dir, 'factory', 'verdicted-tasks.json'));
    const h = hook();
    const off = installVerifyTaskClose({ ledger, verdicted, onRecorded: h.onRecorded });
    h.record(verdict('wtask-pass', 'pass'));
    h.record(verdict('wtask-fail', 'fail'));
    await settle();
    expect(ledger.get('wtask-pass')?.status).toBe('completed');
    expect(ledger.get('wtask-fail')?.status).toBe('completed');
    expect(verdicted.has('wtask-pass') && verdicted.has('wtask-fail')).toBe(true);
    off();
    expect(h.count()).toBe(0);
  });

  it('a verdict whose head is no longer the PR\'s still closes the task it rests on; a human verdict closes nothing', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-stale');
    await verifyTask(ledger, 'wtask-human');
    const verdicted = new VerdictedTasks(path.join(dir, 'factory', 'verdicted-tasks.json'));
    const h = hook();
    installVerifyTaskClose({ ledger, verdicted, onRecorded: h.onRecorded });
    // The PR moved on to NEXT after this verdict at HEAD: its task still closes.
    h.record(verdict('wtask-stale', 'pass', HEAD));
    h.record(verdict('wtask-human', 'pass', NEXT, null));
    await settle();
    expect(ledger.get('wtask-stale')?.status).toBe('completed');
    expect(ledger.get('wtask-human')?.status).toBe('review_requested');
    expect(verdicted.has('wtask-human')).toBe(false);
  });

  it('a verdicted task sent back while its verdict was written closes when it reports done again', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-back');
    // The verifier sends it back before the verdict's close runs.
    const back = await ledger.update({ id: 'wtask-back', status: 'working', actor: { kind: 'brain', workspaceId: 'ws-v' }, expectedRev: ledger.get('wtask-back')?.rev ?? -1 });
    expect(back.ok).toBe(true);
    const verdicted = new VerdictedTasks(path.join(dir, 'factory', 'verdicted-tasks.json'));
    const h = hook();
    const off = installVerifyTaskClose({ ledger, verdicted, onRecorded: h.onRecorded, onTransition: (fn) => ledger.onTransition(fn) });
    h.record(verdict('wtask-back', 'pass'));
    await settle();
    expect(ledger.get('wtask-back')?.status).toBe('working');
    const again = await ledger.update({ id: 'wtask-back', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'wtask-back-ws' }, expectedRev: ledger.get('wtask-back')?.rev ?? -1 });
    expect(again.ok).toBe(true);
    await settle();
    expect(ledger.get('wtask-back')?.status).toBe('completed');
    off();
  });

  it('on install, closes a verify task whose verdict was recorded before a quit and only that one', async () => {
    const ledger = new TaskLedger({ dir });
    await verifyTask(ledger, 'wtask-done');
    await verifyTask(ledger, 'wtask-waiting');
    const verdicted = new VerdictedTasks(path.join(dir, 'factory', 'verdicted-tasks.json'));
    verdicted.load();
    verdicted.add('wtask-done');
    installVerifyTaskClose({ ledger, verdicted, onRecorded: hook().onRecorded });
    await settle();
    expect(ledger.get('wtask-done')?.status).toBe('completed');
    expect(ledger.get('wtask-waiting')?.status).toBe('review_requested');
  });
});
