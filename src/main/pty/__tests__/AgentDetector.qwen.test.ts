import { describe, expect, it, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';
import qwen from './fixtures/qwen-code-0.26.1.json';

// Replays the PTY frames of one live Qwen Code 0.26.1 session (see the
// fixture's note): launch, a streamed turn, a run_shell_command permission
// dialog, and the turn after it was approved.
type Step = keyof typeof qwen.frames;
const SESSION: readonly Step[] = ['start', 'working', 'turnDone', 'approval', 'afterApproval'];

function replay(chunkSize: number) {
  const det = new AgentDetector();
  const cb = vi.fn();
  det.onEvent(cb);
  const seen: Record<string, string[]> = {};
  for (const step of SESSION) {
    // PTYBridge clears the dedup on each new activity cycle; a turn is one.
    det.resetEmissionState();
    cb.mockClear();
    const bytes = qwen.frames[step];
    for (let i = 0; i < bytes.length; i += chunkSize) det.feed(bytes.slice(i, i + chunkSize));
    seen[step] = cb.mock.calls.map(([e]) => `${e.agent}:${e.status}`);
  }
  return { det, seen };
}

describe('Qwen Code screen profile (0.26.1 live capture)', () => {
  it.each([65536, 4096, 97])('reads every state of the captured session (%i-byte reads)', (chunkSize) => {
    const { det, seen } = replay(chunkSize);
    expect(det.getLastAgent()).toBe('Qwen Code');
    expect(seen).toEqual({
      start: ['Qwen Code:running', 'Qwen Code:waiting'],
      // The queued-prompt footer (`… ⏳ 1 queued`) is not idle.
      working: ['Qwen Code:running'],
      turnDone: ['Qwen Code:waiting'],
      approval: ['Qwen Code:awaiting_input'],
      afterApproval: ['Qwen Code:running', 'Qwen Code:waiting'],
    });
  });

  it('names the approval for the command dialog', () => {
    const det = new AgentDetector();
    const cb = vi.fn();
    det.onEvent(cb);
    det.feed(qwen.frames.start);
    det.feed(qwen.frames.approval);
    expect(cb.mock.calls.at(-1)?.[0]).toEqual({ agent: 'Qwen Code', status: 'awaiting_input', message: 'Command approval requested' });
  });

  it('does not take a live Claude pane that quotes the banner or the dialog', () => {
    const det = new AgentDetector();
    const cb = vi.fn();
    det.onEvent(cb);
    det.feed('Claude Code v2.1.172\n  bypass permissions on\n');
    det.feed('│ >_ Qwen Code (v0.26.1)                                   │\n');
    det.feed("   Allow execution of: 'touch'?\n");
    expect(det.getLastAgent()).toBe('Claude Code');
    expect(cb.mock.calls.map(([e]) => e.agent)).not.toContain('Qwen Code');
  });
});
