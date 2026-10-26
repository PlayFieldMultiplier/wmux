// Kimi Code CLI writes OSC 133 A/B/C of its own around its transcript, mid-turn
// included. While it owns the pane they are not the shell's prompt or a launch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';

// Kimi Code CLI 2.3.2 live capture (src/main/pty/__tests__/fixtures).
const kimiCapture = JSON.parse(readFileSync(join(__dirname, '../../main/pty/__tests__/fixtures/kimi-2.3.2-capture.json'), 'utf8')) as {
  chunks: { startup: string; working: string; replyEnd: string };
};

function fakePty() {
  let data: ((chunk: string) => void) | null = null;
  return {
    pty: {
      onData: (cb: (chunk: string) => void) => { data = cb; return { dispose: () => { data = null; } }; },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty,
    feed: (chunk: string) => data?.(chunk),
  };
}

describe('an agent\'s own OSC 133 marks', () => {
  let bridge: DaemonPTYBridge;
  let pty: ReturnType<typeof fakePty>;
  let prompts: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    bridge = new DaemonPTYBridge();
    pty = fakePty();
    bridge.setupDataForwarding(pty.pty, new RingBuffer(1 << 20), 'pane-a', new PromptEventLog());
    prompts = vi.fn();
    bridge.on('prompt', prompts);
    vi.advanceTimersByTime(1);
  });
  afterEach(() => { bridge.cleanup(); vi.useRealTimers(); });

  it('keep Kimi\'s turn open and count no launch; the shell\'s D and prompt still count', () => {
    const { startup, working, replyEnd } = kimiCapture.chunks;
    // Launched in a trusted folder: the shell's C and Kimi's banner in one read.
    pty.feed('\x1b]133;C\x07' + startup);
    expect(bridge.getLastAgent()).toBe('Kimi Code CLI');
    expect(bridge.getCommandStarts()).toBe(1);
    const promptEvents = prompts.mock.calls.length;
    bridge.noteInput('hi\r');
    // Kimi's A/B/C around the prompt, and B/C again mid-reply.
    pty.feed(working);
    pty.feed(replyEnd);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getCommandStarts()).toBe(1);
    expect(prompts).toHaveBeenCalledTimes(promptEvents);
    // Kimi exits: the shell's D, then its prompt, in one read.
    pty.feed('\x1b]133;D;0\x07\x1b]133;A\x07');
    expect(prompts.mock.calls.slice(promptEvents).map((c) => (c[0] as { event: { type: string } }).event.type))
      .toEqual(['command_end', 'prompt_start']);
  });

  const promptTypes = () => prompts.mock.calls.map((c) => (c[0] as { event: { type: string } }).event.type);

  it('are told apart mark by mark when Kimi\'s banner and its own marks share a read', () => {
    const { startup, working } = kimiCapture.chunks;
    pty.feed('\x1b]133;C\x07');
    pty.feed(startup + working);
    expect(bridge.getLastAgent()).toBe('Kimi Code CLI');
    expect(bridge.getCommandStarts()).toBe(1);
    expect(promptTypes()).toEqual(['command_start']);
  });

  it('are told apart in a muted pane\'s held output when it is replayed', () => {
    const { startup, working } = kimiCapture.chunks;
    bridge.setMuted(true);
    pty.feed('\x1b]133;C\x07');
    pty.feed(startup);
    pty.feed(working);
    bridge.setMuted(false, { replayHeld: true });
    expect(bridge.getCommandStarts()).toBe(1);
    expect(promptTypes()).toEqual(['command_start']);
  });
});
