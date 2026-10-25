import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResumeBinding } from '../../../shared/agentResume';
import { StallWatch, STALL_COUNTER_MS, STALL_FALLBACK_MS, lastHumanPrompt, stopAndPrefill, transcriptToolInFlight } from '../stallWatch';

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
  const binding: ResumeBinding = { agent: opts.agent ?? 'claude', sessionId: 's', cwd: dir, transcriptPath: file, ts: 0 };
  const watch = new StallWatch({
    listSessionIds: () => ['pty-1'],
    getBinding: () => binding,
    midTurn: () => state.turn,
    awaitingHuman: () => state.awaiting,
    readScreen: async () => state.rows,
    titleRunning: () => state.title,
    emit: (_id, since) => events.push(since),
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
  return { file, state, events, watch, run, stalled, advance: (ms: number) => { now += ms; } };
}

describe('StallWatch', () => {
  it('reads 180 s of silence with a frozen token count as stuck', async () => {
    const h = harness();
    await h.run(STALL_COUNTER_MS - 10_000);
    expect(h.stalled()).toBe(false);
    await h.run(10_000);
    expect(h.stalled()).toBe(true);
    // Reported as stuck since the last progress.
    expect(h.watch.stalledSince('pty-1')).toBe(1_000_000);
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
