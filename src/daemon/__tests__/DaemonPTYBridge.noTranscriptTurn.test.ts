// A Codex /status submit opens the daemon's episode but runs no turn on the
// pane's own thread; the only stop it draws is another thread's, which the
// daemon drops. noteNoTranscriptTurn ends that episode once the pane's own
// transcript shows its last turn finished (daemon/index.ts, gateCodexStop drop).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';

describe('DaemonPTYBridge — an episode no transcript turn backs', () => {
  let bridge: DaemonPTYBridge;
  let turns: Array<number | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const pty = { onData: () => ({ dispose() { /* no-op */ } }), onExit: () => ({ dispose() { /* no-op */ } }) } as unknown as IPty;
    bridge.setupDataForwarding(pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    turns = [];
    bridge.on('agentTurn', (e: { runningSince: number | null }) => turns.push(e.runningSince));
    bridge.noteAgentStatus('running', true);
    vi.advanceTimersByTime(5_000);
    bridge.noteAgentStatus('waiting', true); // the last real turn's Stop
    vi.advanceTimersByTime(5_000);
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('ends the episode a /status submit opened', () => {
    bridge.noteInput('/status\r');
    vi.advanceTimersByTime(3_000);
    expect(bridge.isAgentMidTurn()).toBe(true);
    bridge.noteNoTranscriptTurn();
    expect(bridge.isAgentMidTurn()).toBe(false);
    expect(turns.at(-1)).toBeNull();
  });

  it('leaves a dialog the pane waits on alone', () => {
    bridge.noteInput('fix it\r');
    vi.advanceTimersByTime(300);
    bridge.noteAgentStatus('awaiting_input', true);
    bridge.noteNoTranscriptTurn();
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });
  it('leaves a just-submitted turn alone while its prompt may not have reached the rollout yet', () => {
    bridge.noteInput('fix it\r');
    vi.advanceTimersByTime(300);
    bridge.noteNoTranscriptTurn();
    expect(bridge.isAgentMidTurn()).toBe(true);
  });
});
