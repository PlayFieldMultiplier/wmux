// #2673 — Claude Code with no hooks fires no Stop, and the daemon read no other
// turn end: a turn that finished on its own stayed open (Running in the
// sidebar until the next prompt), and a session's first turn never counted as
// one (#1670's boot episode), so its end reached main as plain byte silence.
// Claude Code refreshes `◐`/`◑` in its title about once a second for the whole
// of every turn and sets `✳` when the turn ends, or when a permission dialog
// opens (titles from live 2.1.310 captures).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';

const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold
const LAUNCH_OUTPUT = '\x1b[?2004l\x1b]133;C\x07';
const IDLE = '\x1b]0;✳ Claude Code\x07';
const RUNNING = '\x1b]0;◐ Claude Code\x07';
const SILENCE_MS = 6000; // past ActivityMonitor's idle delay

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — a hookless Claude Code turn ends in silence under its idle title (#2673)', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let edges: Array<number | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    edges = [];
    bridge.on('agentTurn', (p: { runningSince: number | null }) => edges.push(p.runningSince));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    // Launched from a shell with OSC 133, as wmux's shells are.
    feed('\x1b]133;A\x07$ \x1b]133;B\x07');
    bridge.noteInput('claude --safe-mode\r');
    feed(LAUNCH_OUTPUT);
    vi.advanceTimersByTime(300);
    feed(IDLE + 'Claude Code v2.1.310\r\n  bypass permissions on\r\n' + BIG);
    vi.advanceTimersByTime(SILENCE_MS);
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  /** Submit a prompt and let its turn run for a while under the spinner title. */
  function runTurn(prompt: string): void {
    bridge.noteInput(prompt);
    bridge.noteInput('\r');
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      feed(RUNNING + BIG);
    }
  }

  it('the first turn after the launch counts once the title runs, and ends in silence under the idle title', () => {
    runTurn('reply hi');
    expect(bridge.isAgentMidTurn()).toBe(true);

    feed(IDLE + 'hi\r\n');
    expect(bridge.isTurnOpen()).toBe(true); // the idle title alone ends nothing
    vi.advanceTimersByTime(SILENCE_MS);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(edges).toEqual([expect.any(Number), null]);
  });

  it('a later turn ends the same way', () => {
    runTurn('reply hi');
    feed(IDLE);
    vi.advanceTimersByTime(SILENCE_MS);
    edges.length = 0;

    runTurn('reply bye');
    expect(bridge.isAgentMidTurn()).toBe(true);
    feed(IDLE + 'bye\r\n');
    vi.advanceTimersByTime(SILENCE_MS);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(edges).toEqual([expect.any(Number), null]);
  });

  it('#1670: a first Enter that only answered a dialog stays a boot episode', () => {
    bridge.noteInput('\r'); // "Trust this folder?" answered; no turn starts
    vi.advanceTimersByTime(100);
    feed(IDLE + BIG);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(edges).toEqual([]);
  });

  it('leaves a quiet turn alone when the title is not Claude Code\'s idle one', () => {
    bridge.noteInput('reply hi\r');
    vi.advanceTimersByTime(80);
    feed('\x1b]0;⠋ Working\x07' + BIG); // another agent's title
    vi.advanceTimersByTime(SILENCE_MS);
    expect(bridge.isTurnOpen()).toBe(true);
  });

  it('leaves a turn a hook reports to its Stop hook', () => {
    bridge.noteInput('reply hi\r');
    bridge.noteAgentStatus('running', true); // UserPromptSubmit
    feed(RUNNING + BIG);
    feed(IDLE);
    vi.advanceTimersByTime(SILENCE_MS);
    expect(bridge.isAgentMidTurn()).toBe(true);
    expect(edges).toEqual([expect.any(Number)]); // one start, from the hook; no end
  });

  it('never ends a turn waiting on a permission dialog, whose title is idle too', () => {
    runTurn('run the build');
    feed(IDLE); // set a few ms before the dialog's rows
    bridge.noteAgentStatus('awaiting_input'); // the detector's permission dialog
    // The dialog's own paint. Recognising the dialog ends the activity cycle,
    // so without output behind it no idle edge would come to test at all.
    feed(BIG);
    vi.advanceTimersByTime(SILENCE_MS);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });
});
