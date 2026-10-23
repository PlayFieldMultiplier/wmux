import { describe, expect, it } from 'vitest';
import { SHELL_PROMPT_QUIET_MS, ShellPromptWatcher } from '../ShellPromptWatcher';
import { lastNonBlankRow } from '../shellPromptShape';
import type { TtyWait } from '../foregroundTtyWait';
import type { ShellPromptChange, ShellPromptSignal } from '../../../shared/shellPrompt';

/** One pane whose every signal the test sets, and a clock the test moves. */
function rig(over: Partial<{ agentPresent: boolean; commandRunning: boolean; altScreen: boolean; rows: string[]; tail: string | null; ttyWait: TtyWait }> = {}) {
  let now = 0;
  const pane = {
    agentPresent: false,
    commandRunning: true,
    altScreen: false,
    bytes: 100,
    keyRevision: 0,
    pid: 4321,
    rows: ['$ git push origin feat/x', 'Push anyway? [y/N] '],
    ttyWait: 'unknown' as TtyWait,
    gone: false,
    /** The raw output's last line; undefined reads it off the rows. */
    tail: undefined as string | null | undefined,
    ...over,
  };
  const emits: Array<ShellPromptSignal | null> = [];
  const changes: ShellPromptChange[] = [];
  let reads = 0;
  const watcher = new ShellPromptWatcher({
    listSessionIds: () => (pane.gone ? [] : ['p1']),
    probe: () => (pane.gone ? null : {
      agentPresent: pane.agentPresent, commandRunning: pane.commandRunning, altScreen: pane.altScreen,
      bytes: pane.bytes, keyRevision: pane.keyRevision, pid: pane.pid,
    }),
    tailLine: () => (pane.tail !== undefined ? pane.tail : lastNonBlankRow(pane.rows)),
    readRows: async () => { reads += 1; return pane.rows; },
    ttyWait: () => pane.ttyWait,
    emit: (_id, change) => { changes.push(change); emits.push(change.prompt); },
    epoch: 'epoch-test',
    now: () => now,
  });
  /** Moves the clock and runs one pass. */
  const after = async (ms: number) => { now += ms; await watcher.tick(); };
  /** First sight of the pane, then past the quiet window. */
  const settle = async () => { await after(0); await after(SHELL_PROMPT_QUIET_MS + 100); };
  return { pane, emits, changes, watcher, after, settle, reads: () => reads };
}

describe('ShellPromptWatcher: all five signals make one record', () => {
  it('no agent + a command running + quiet on the main screen + a prompt row (+ no non-input wait)', async () => {
    const r = rig();
    await r.settle();
    expect(r.emits).toEqual([{ shape: 'yes-no', question: 'Push anyway? [y/N]' }]);
    // Once per settled screen: not read or sent again while nothing moves.
    await r.after(5000);
    expect(r.emits).toHaveLength(1);
    expect(r.reads()).toBe(1);
  });

  it('on Linux a foreground process read off the terminal counts too', async () => {
    const r = rig({ ttyWait: 'reads' });
    await r.settle();
    expect(r.emits).toEqual([{ shape: 'yes-no', question: 'Push anyway? [y/N]' }]);
  });
});

describe('ShellPromptWatcher: one signal alone makes no record', () => {
  it('a quiet build: a command running quietly, its last row no prompt', async () => {
    const r = rig({ rows: ['$ cargo build', '   Compiling serde v1.0.210'] });
    await r.settle();
    expect(r.emits).toEqual([]);
  });

  it('a settle whose raw last line is no prompt renders nothing', async () => {
    // A dev server or `tail -f` that pauses again and again: the screen is never rebuilt.
    const r = rig({ tail: 'GET /api/health 200 3ms' });
    await r.settle();
    for (let i = 0; i < 5; i++) {
      r.pane.bytes += 40;
      await r.after(0);
      await r.after(SHELL_PROMPT_QUIET_MS + 100);
    }
    expect(r.emits).toEqual([]);
    expect(r.reads()).toBe(0);
  });

  it('a raw last line that looks like a prompt is still judged on the rendered screen', async () => {
    // The raw tail can lie (a redraw moved the cursor up); the rendered rows decide.
    const r = rig({ tail: 'Continue? [y/N]', rows: ['$ make', 'done'] });
    await r.settle();
    expect(r.reads()).toBe(1);
    expect(r.emits).toEqual([]);
  });

  it('a log line that ends in "(y/N)" while output keeps coming', async () => {
    const r = rig({ rows: ['step 3: overwrite (y/N)'] });
    await r.after(0);
    for (let i = 0; i < 10; i++) {
      r.pane.bytes += 50;
      await r.after(SHELL_PROMPT_QUIET_MS / 2);
    }
    expect(r.emits).toEqual([]);
    expect(r.reads()).toBe(0);
  });

  it('`cat` waiting on stdin: it reads the terminal, but nothing on screen asks anything', async () => {
    const r = rig({ rows: ['$ cat'], ttyWait: 'reads' });
    await r.settle();
    expect(r.emits).toEqual([]);
  });

  it.each([
    ['an agent in the pane', { agentPresent: true }],
    ['no command running (the shell is at its own prompt)', { commandRunning: false }],
    ['the alternate screen (vim, less)', { altScreen: true }],
    ['a foreground process blocked on something else (Linux)', { ttyWait: 'other' as TtyWait }],
  ])('a prompt row with %s', async (_name, over) => {
    const r = rig(over);
    await r.settle();
    expect(r.emits).toEqual([]);
  });

  it('a prompt row before the quiet window has passed', async () => {
    const r = rig();
    await r.after(0);
    await r.after(SHELL_PROMPT_QUIET_MS - 200);
    expect(r.emits).toEqual([]);
    expect(r.reads()).toBe(0);
  });
});

describe('ShellPromptWatcher: a password prompt', () => {
  it('is reported by its shape alone: the row never leaves the watcher', async () => {
    const r = rig({ rows: ['$ sudo true', '[sudo] password for someone: '] });
    await r.settle();
    expect(r.emits).toEqual([{ shape: 'secret' }]);
    expect(Object.keys(r.emits[0] ?? {})).toEqual(['shape']);
  });

  it('a key typed before it was found keeps it from being raised at all', async () => {
    for (const via of ['event', 'pass'] as const) {
      const r = rig({ rows: ['Password:'] });
      await r.after(0);
      await r.after(SHELL_PROMPT_QUIET_MS / 2);
      r.pane.keyRevision += 1;
      if (via === 'event') r.watcher.noteKey('p1');
      await r.after(SHELL_PROMPT_QUIET_MS / 2);
      await r.after(SHELL_PROMPT_QUIET_MS * 2);
      expect(r.emits).toEqual([]);
    }
  });

  it('a key typed blind clears it, and the same screen does not raise it again', async () => {
    const r = rig({ rows: ['Password:'] });
    await r.settle();
    r.pane.keyRevision += 1;
    r.watcher.noteKey('p1');
    expect(r.emits).toEqual([{ shape: 'secret' }, null]);
    await r.after(5000);
    await r.after(5000);
    expect(r.emits).toEqual([{ shape: 'secret' }, null]);
  });
});

describe('ShellPromptWatcher: the record clears', () => {
  it('when the command finishes', async () => {
    const r = rig();
    await r.settle();
    r.watcher.noteCommandEnd('p1');
    r.pane.commandRunning = false;
    await r.after(5000);
    expect(r.emits).toEqual([{ shape: 'yes-no', question: 'Push anyway? [y/N]' }, null]);
  });

  it('when a key arrives, seen by the event or by the next pass', async () => {
    const byEvent = rig();
    await byEvent.settle();
    byEvent.pane.keyRevision += 1;
    byEvent.watcher.noteKey('p1');
    expect(byEvent.emits.at(-1)).toBeNull();

    const byPass = rig();
    await byPass.settle();
    byPass.pane.keyRevision += 1;
    await byPass.after(500);
    expect(byPass.emits).toEqual([{ shape: 'yes-no', question: 'Push anyway? [y/N]' }, null]);
  });

  it('when output moves, and a new prompt after it is reported anew', async () => {
    const r = rig();
    await r.settle();
    r.pane.bytes += 30;
    r.pane.rows = ['Push anyway? [y/N] y', 'Really force-push? (yes/no)'];
    await r.after(500);
    expect(r.emits.at(-1)).toBeNull();
    await r.after(SHELL_PROMPT_QUIET_MS + 100);
    expect(r.emits).toEqual([
      { shape: 'yes-no', question: 'Push anyway? [y/N]' },
      null,
      { shape: 'yes-no', question: 'Really force-push? (yes/no)' },
    ]);
  });

  it('list() holds what is shown, for a client that connects later', async () => {
    const r = rig();
    expect(r.watcher.list()).toEqual({ epoch: 'epoch-test', seq: 0, prompts: [] });
    await r.settle();
    expect(r.watcher.list()).toEqual({
      epoch: 'epoch-test',
      seq: 1,
      prompts: [{ sessionId: 'p1', prompt: { shape: 'yes-no', question: 'Push anyway? [y/N]' }, seq: 1 }],
    });
    r.watcher.noteCommandEnd('p1');
    expect(r.watcher.list()).toEqual({ epoch: 'epoch-test', seq: 2, prompts: [] });
  });

  it('every set and clear takes the next seq, so main can order them against the list', async () => {
    const r = rig();
    await r.settle();
    r.pane.bytes += 30;
    r.pane.rows = ['Really force-push? (yes/no)'];
    await r.after(500);
    await r.after(SHELL_PROMPT_QUIET_MS + 100);
    r.watcher.dropSession('p1');
    expect(r.changes.map((c) => [c.seq, c.prompt?.shape ?? null])).toEqual([[1, 'yes-no'], [2, null], [3, 'yes-no'], [4, null]]);
    expect(new Set(r.changes.map((c) => c.epoch))).toEqual(new Set(['epoch-test']));
  });

  it('when the pane goes away', async () => {
    const r = rig();
    await r.settle();
    r.pane.gone = true;
    await r.after(500);
    expect(r.emits.at(-1)).toBeNull();
  });
});
