import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResumeBinding } from '../../../shared/agentResume';
import { StallWatch, SPIN_COMPACTIONS, STALL_COUNTER_MS, STALL_FALLBACK_MS, lastHumanPrompt, stopAndPrefill, transcriptToolInFlight } from '../stallWatch';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-watch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ts = '2026-10-25T12:00:00.000Z';
const prompt = (text: string) => JSON.stringify({ type: 'user', uuid: `p-${text.length}`, timestamp: ts, message: { role: 'user', content: text } });
const tool = (id: string, name: string) => JSON.stringify({
  type: 'assistant', uuid: `u-${id}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const result = (id: string) => JSON.stringify({
  type: 'user', uuid: `r-${id}`, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
/** Claude's summary row after a compaction, as it writes it. */
const compaction = (n: number) => JSON.stringify({
  type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, uuid: `c-${n}`, timestamp: ts,
  message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' },
});
const call = (id: string, name: string, input: Record<string, unknown>) => JSON.stringify({
  type: 'assistant', uuid: `u-${id}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const subagentLine = () => JSON.stringify({
  type: 'assistant', isSidechain: true, uuid: 's-1', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
});

function append(file: string, ...lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
}

/** The spinner row as Claude draws it: with a token count, while thinking (an
 *  earlier count standing still, or none), or gone. */
const spinner = (count?: string, phase?: 'thinking') => [
  'some output',
  count ? `✻ Embellishing… (2m 3s · ↓ ${count} tokens${phase ? ' · deep in thought with high effort' : ''})` : '✻ Frosting… (2m 3s · deep in thought with high effort)',
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
];

function harness(opts: { agent?: ResumeBinding['agent'] } = {}) {
  const file = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(file, `${prompt('do the thing')}\n`);
  let now = 1_000_000;
  const state = { turn: 't1:a.1' as string | null, awaiting: false, rows: spinner('1.2k') as string[] | null, title: false };
  const events: Array<number | null> = [];
  const counts: Array<number | undefined> = [];
  const binding: ResumeBinding = { agent: opts.agent ?? 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
  const watch = new StallWatch({
    listSessionIds: () => ['pty-1'],
    getBinding: () => binding,
    midTurn: () => state.turn,
    awaitingHuman: () => state.awaiting,
    readScreen: async () => state.rows,
    titleRunning: () => state.title,
    emit: (_id, since, compactions) => { events.push(since); counts.push(compactions); },
    now: () => now,
  });
  /** Tick every 10 s until `ms` has passed since the start of this call. */
  const run = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      await watch.tick();
      now = Math.min(end, now + 10_000);
    }
    await watch.tick();
  };
  const stalled = () => events.length > 0 && events[events.length - 1] !== null;
  /** The compaction count of the alert standing now; undefined for none or a silent stall. */
  const spinning = () => (stalled() ? counts[counts.length - 1] : undefined);
  return { file, state, events, counts, watch, run, stalled, spinning, advance: (ms: number) => { now += ms; } };
}

describe('StallWatch', () => {
  it('reads 180 s of silence with a frozen token count as stuck', async () => {
    const h = harness();
    await h.run(STALL_COUNTER_MS - 10_000);
    expect(h.stalled()).toBe(false);
    await h.run(10_000);
    expect(h.stalled()).toBe(true);
    // Reported as stuck since the last progress, for the turn it was seen in.
    expect(h.watch.stalledSince('pty-1')).toBe(1_000_000);
    expect(h.watch.stalledTurn('pty-1')).toBe(h.state.turn);
    h.state.turn = 'turn-2';
    await h.run(10_000);
    expect(h.watch.stalledTurn('pty-1')).toBeUndefined();
  });

  it('never reads a moving token count as stuck, even at 246 s of silence', async () => {
    const h = harness();
    let n = 100;
    for (let i = 0; i < 25; i++) {
      h.state.rows = spinner(String(n += 37));
      await h.run(10_000);
    }
    expect(h.events).toEqual([]);
  });

  it('falls back to 10 min when no token count can be read', async () => {
    const h = harness();
    h.state.rows = spinner();
    await h.run(9 * 60_000);
    expect(h.stalled()).toBe(false);
    await h.run(STALL_FALLBACK_MS - 9 * 60_000);
    expect(h.stalled()).toBe(true);
  });

  it('reads the last spinner-like row, the live one under earlier output', async () => {
    const h = harness();
    // An old frozen row in the scrollback above, the live counting row below.
    let n = 100;
    for (let i = 0; i < 25; i++) {
      h.state.rows = [spinner('9.9k')[1], ...spinner(String(n += 37))];
      await h.run(10_000);
    }
    expect(h.events).toEqual([]);
  });

  it('reads a count shown while thinking as no count: it stands still through healthy thinking', async () => {
    const h = harness();
    h.state.rows = spinner('262', 'thinking');
    await h.run(9 * 60_000);
    expect(h.stalled()).toBe(false);
    await h.run(STALL_FALLBACK_MS - 9 * 60_000);
    expect(h.stalled()).toBe(true);
  });

  it('needs the agent to say it is running: its spinner row or its running title', async () => {
    const h = harness();
    h.state.rows = ['some output', '──────────────────────────────', '❯ ', '──────────────────────────────'];
    await h.run(STALL_FALLBACK_MS * 2);
    expect(h.stalled()).toBe(false);
    // An unreadable screen with a running title (answer text streaming hides the row).
    h.state.rows = null;
    h.state.title = true;
    await h.run(10_000);
    expect(h.stalled()).toBe(true);
  });

  it('never reads a tool in flight as stuck: a Bash run for 15 min, or a subagent', async () => {
    const bash = harness();
    append(bash.file, tool('b1', 'Bash'));
    await bash.run(15 * 60_000);
    expect(bash.events).toEqual([]);

    const sub = harness();
    // The subagent writes to its own file; the parent's Agent call stays open.
    append(sub.file, tool('a1', 'Agent'), subagentLine());
    await sub.run(15 * 60_000);
    expect(sub.events).toEqual([]);
  });

  it('keeps a call open across a notice Claude writes as a user row mid-turn', async () => {
    const h = harness();
    append(h.file, tool('a1', 'Agent'), prompt('<task-notification><task-id>b1</task-id><status>completed</status></task-notification>'));
    await h.run(15 * 60_000);
    expect(h.events).toEqual([]);
  });

  it('clears on an append and counts the silence again from there', async () => {
    const h = harness();
    await h.run(STALL_COUNTER_MS);
    expect(h.stalled()).toBe(true);
    append(h.file, tool('g1', 'Glob'), result('g1'));
    await h.run(0);
    expect(h.stalled()).toBe(false);
    await h.run(STALL_COUNTER_MS);
    expect(h.stalled()).toBe(true);
  });

  it('Keep waiting doubles the threshold for this turn, and a new prompt resets it', async () => {
    const h = harness();
    await h.run(STALL_COUNTER_MS);
    expect(h.watch.keepWaiting('pty-1')).toBe(true);
    expect(h.stalled()).toBe(false);
    await h.run(STALL_COUNTER_MS - 10_000);
    expect(h.stalled()).toBe(false);
    await h.run(10_000);
    expect(h.stalled()).toBe(true);

    h.watch.noteHookSignal('pty-1', 'agent.user_prompt_submit');
    expect(h.stalled()).toBe(false);
    await h.run(STALL_COUNTER_MS);
    expect(h.stalled()).toBe(true);
  });

  it('never alerts while the human is asked, after a tool start, or for an agent other than Claude', async () => {
    const asked = harness();
    asked.state.awaiting = true;
    await asked.run(STALL_FALLBACK_MS);
    expect(asked.events).toEqual([]);

    const started = harness();
    await started.run(60_000);
    // A tool the hook saw start holds until the transcript moves again.
    started.watch.noteHookSignal('pty-1', 'agent.tool_started');
    await started.run(STALL_FALLBACK_MS * 2);
    expect(started.events).toEqual([]);

    const codex = harness({ agent: 'codex' });
    await codex.run(STALL_FALLBACK_MS * 2);
    expect(codex.events).toEqual([]);
  });

  it('clears when the turn ends', async () => {
    const h = harness();
    await h.run(STALL_COUNTER_MS);
    expect(h.stalled()).toBe(true);
    h.state.turn = null;
    await h.run(0);
    expect(h.stalled()).toBe(false);
  });
});

describe('StallWatch: a turn that keeps compacting without editing', () => {
  /** Append each line on its own tick, as a turn would write them. */
  const write = async (h: ReturnType<typeof harness>, ...lines: string[]) => {
    for (const line of lines) {
      append(h.file, line);
      await h.run(10_000);
    }
  };
  const compactions = (from: number, n: number) => Array.from({ length: n }, (_, i) => compaction(from + i));

  it('alerts at three compactions with no edit, with the count, and an append does not clear it', async () => {
    const h = harness();
    await h.run(10_000);
    await write(h, compaction(1), tool('r1', 'Read'), result('r1'), compaction(2), tool('r2', 'Read'), result('r2'));
    expect(h.stalled()).toBe(false);
    await write(h, compaction(3));
    expect(h.spinning()).toBe(SPIN_COMPACTIONS);
    // Since the first compaction it counts, for the turn it was seen in.
    expect(h.watch.stalledSince('pty-1')).toBe(Date.parse(ts));
    expect(h.watch.stallCompactions('pty-1')).toBe(3);
    expect(h.watch.stalledTurn('pty-1')).toBe(h.state.turn);
    // Busy writing is not progress here: the alert stands, and follows the count.
    await write(h, tool('r3', 'Read'), result('r3'), compaction(4));
    expect(h.events.filter((e) => e === null)).toEqual([]);
    expect(h.spinning()).toBe(4);
    // The turn ends.
    h.state.turn = null;
    await h.run(0);
    expect(h.stalled()).toBe(false);
  });

  it('an edit between them starts the count again', async () => {
    const h = harness();
    await h.run(10_000);
    await write(h, compaction(1), call('e', 'Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b' }), result('e'), ...compactions(2, 2));
    expect(h.events).toEqual([]);
    await write(h, compaction(4));
    expect(h.spinning()).toBe(3);
    // Any edit-type call clears it.
    await write(h, call('w', 'Write', { file_path: '/y.ts', content: '' }));
    expect(h.stalled()).toBe(false);
  });

  it('a git commit counts as an edit; another shell command does not', async () => {
    const h = harness();
    await h.run(10_000);
    await write(h, compaction(1), call('c', 'Bash', { command: 'git -C /repo commit -m "wip"' }), ...compactions(2, 2));
    expect(h.events).toEqual([]);
    await write(h, call('l', 'Bash', { command: 'git log --oneline | head' }), compaction(4));
    expect(h.spinning()).toBe(3);
  });

  it('never carries a count from one turn into the next', async () => {
    const h = harness();
    await h.run(10_000);
    await write(h, ...compactions(1, 2));
    append(h.file, prompt('next task'));
    h.state.turn = 't2:a.1';
    await write(h, ...compactions(3, 2));
    expect(h.events).toEqual([]);
    await write(h, compaction(5));
    expect(h.spinning()).toBe(3);
  });

  it('Keep waiting doubles the count for this turn, and a new prompt resets it', async () => {
    const h = harness();
    await h.run(10_000);
    await write(h, ...compactions(1, 3));
    expect(h.spinning()).toBe(3);
    expect(h.watch.keepWaiting('pty-1')).toBe(true);
    expect(h.stalled()).toBe(false);
    await write(h, ...compactions(4, 2));
    expect(h.stalled()).toBe(false);
    await write(h, compaction(6));
    expect(h.spinning()).toBe(6);

    await write(h, prompt('try another way'), ...compactions(7, 3));
    expect(h.spinning()).toBe(3);
  });

  it('cannot tell from a tail that does not show the turn\'s start', async () => {
    const h = harness();
    // The prompt is more than one read back when the watch first sees the turn.
    for (let i = 0; i < 300; i++) append(h.file, JSON.stringify({ type: 'assistant', uuid: `a-${i}`, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1024) }] } }));
    await h.run(10_000);
    await write(h, ...compactions(1, 4));
    expect(h.events).toEqual([]);
  });

  it('never alerts while the human is asked, nor while the agent does not say it is running', async () => {
    const h = harness();
    h.state.awaiting = true;
    await h.run(10_000);
    await write(h, ...compactions(1, 3));
    expect(h.events).toEqual([]);
    h.state.awaiting = false;
    h.state.rows = null;
    await h.run(10_000);
    expect(h.events).toEqual([]);
    h.state.rows = spinner('1.2k');
    await h.run(10_000);
    expect(h.spinning()).toBe(3);
  });

  it('reads the compaction summary as no prompt: Stop and prefill never puts it back', () => {
    const entries = [prompt('fix it'), tool('r', 'Read'), result('r'), compaction(1)].map((l) => JSON.parse(l));
    expect(lastHumanPrompt(entries)).toBe('fix it');
    expect(lastHumanPrompt([JSON.parse(compaction(1))])).toBeNull();
  });
});

describe('the turn\'s own prompt and its open tools', () => {
  const parse = (...lines: string[]) => lines.map((l) => JSON.parse(l));
  it('takes the current turn\'s prompt in full, never an earlier one or a command', () => {
    const long = 'x'.repeat(9000);
    expect(lastHumanPrompt(parse(prompt('first'), tool('g', 'Glob'), result('g'), prompt(long)))).toBe(long);
    // A turn started from a slash command cannot be put back as typed.
    expect(lastHumanPrompt(parse(prompt('first'), prompt('<command-name>/review</command-name><command-args></command-args>')))).toBeNull();
    // Claude's interrupt row is skipped to the prompt it interrupted.
    expect(lastHumanPrompt(parse(prompt('fix it'), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })))).toBe('fix it');
    expect(lastHumanPrompt(parse(tool('g', 'Glob'), result('g')))).toBeNull();
    // A notice mid-turn: nothing to put back, and never the prompt before it.
    expect(lastHumanPrompt(parse(prompt('fix it'), tool('a', 'Agent'), prompt('<task-notification>done</task-notification>')))).toBeNull();
  });

  it('cannot tell from a cut window with no prompt in it', () => {
    expect(transcriptToolInFlight(parse(tool('g', 'Glob'), result('g')), { windowCut: true })).toBeNull();
    expect(transcriptToolInFlight(parse(prompt('go'), tool('g', 'Glob'), result('g')), { windowCut: true })).toBe(false);
    expect(transcriptToolInFlight(parse(prompt('go'), tool('a', 'Agent')))).toBe(true);
  });
});

describe('stopAndPrefill', () => {
  const rule = '──────────────────────────────';
  const composer = (text: string) => ['Interrupted · What should Claude do instead?', rule, `❯ ${text}`, rule];

  it('leaves the input alone when Claude put the interrupted prompt back itself', async () => {
    const writes: string[] = [];
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'sent',
      lastPrompt: () => 'do the thing',
      readScreen: async () => composer('do the thing'),
      write: (data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });
    expect(res).toBe('kept');
    expect(writes).toEqual([]);
  });

  it('pastes the last prompt into an empty input, without Enter', async () => {
    const writes: string[] = [];
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'sent',
      lastPrompt: () => 'line one\nline two',
      readScreen: async () => composer(''),
      write: (data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });
    expect(res).toBe('filled');
    expect(writes).toEqual(['\x1b[200~line one\nline two\x1b[201~']);
  });

  it('reads the input once more right before the paste, and leaves text typed meanwhile', async () => {
    const writes: string[] = [];
    let reads = 0;
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'sent',
      lastPrompt: () => 'do the thing',
      readScreen: async () => (++reads <= 6 ? composer('') : composer('my own words')),
      write: (data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });
    expect(res).toBe('kept');
    expect(writes).toEqual([]);
  });

  it('pastes nothing when a new turn started after the interrupt', async () => {
    const writes: string[] = [];
    let turn = 't1:a.3';
    let reads = 0;
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'sent',
      lastPrompt: () => 'do the thing',
      turnId: () => turn,
      // The user typed and sent their own prompt while the input sat empty.
      readScreen: async () => { if (++reads === 3) turn = 't1:a.4'; return composer(''); },
      write: (data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });
    expect(res).toBe('kept');
    expect(writes).toEqual([]);
  });

  it('pastes nothing while the chat send queue holds the keyboard', async () => {
    const writes: string[] = [];
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'sent',
      lastPrompt: () => 'do the thing',
      readScreen: async () => composer(''),
      write: (data) => { writes.push(data); return true; },
      holdKeyboard: () => null,
      delay: async () => undefined,
    });
    expect(res).toBe('stopped');
    expect(writes).toEqual([]);
  });

  it('sends no ESC at all while a dialog or an approval waits on the human', async () => {
    let interrupted = false;
    const res = await stopAndPrefill({
      blocked: () => true,
      interrupt: async () => { interrupted = true; return 'sent'; },
      lastPrompt: () => 'do the thing',
      readScreen: async () => composer(''),
      write: () => true,
      delay: async () => undefined,
    });
    expect(res).toBe('blocked');
    expect(interrupted).toBe(false);
  });

  it('pastes nothing when the turn could not be stopped', async () => {
    const writes: string[] = [];
    const res = await stopAndPrefill({
      blocked: () => false,
      interrupt: async () => 'blocked',
      lastPrompt: () => 'do the thing',
      readScreen: async () => composer(''),
      write: (data) => { writes.push(data); return true; },
      delay: async () => undefined,
    });
    expect(res).toBe('blocked');
    expect(writes).toEqual([]);
  });
});
