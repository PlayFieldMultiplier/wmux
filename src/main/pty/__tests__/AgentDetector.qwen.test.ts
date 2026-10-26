import { describe, expect, it, vi } from 'vitest';
import { AgentDetector } from '../AgentDetector';
import wide from './fixtures/qwen-code-0.26.1-120x40.json';
import narrow from './fixtures/qwen-code-0.26.1-60x30.json';

// Replays the PTY frames of two live Qwen Code 0.26.1 sessions (see each
// fixture's note): launch, a streamed turn, permission dialogs, and the turns
// after them.
function replay(frames: Record<string, string>, steps: readonly string[], chunkSize: number) {
  const det = new AgentDetector();
  const cb = vi.fn();
  det.onEvent(cb);
  const seen: Record<string, string[]> = {};
  for (const step of steps) {
    // PTYBridge clears the dedup on each new activity cycle; a step is one.
    det.resetEmissionState();
    cb.mockClear();
    const bytes = frames[step];
    for (let i = 0; i < bytes.length; i += chunkSize) det.feed(bytes.slice(i, i + chunkSize));
    seen[step] = cb.mock.calls.map(([e]) => `${e.status}:${e.message}`);
  }
  return { det, seen };
}

const STARTED = 'running:Agent started';
const IDLE = 'waiting:Ready for input';
const WORKING = 'running:Working';
const ASKING = 'awaiting_input:Approval requested';

describe('Qwen Code screen profile (0.26.1 live capture)', () => {
  it.each([65536, 4096, 97])('reads every state of the 120x40 session (%i-byte reads)', (chunkSize) => {
    const { det, seen } = replay(wide.frames, ['start', 'working', 'turnDone', 'approval', 'afterApproval'], chunkSize);
    expect(det.getLastAgent()).toBe('Qwen Code');
    expect(seen).toEqual({
      start: [STARTED, IDLE],
      // The queued-prompt footer (`… ⏳ 1 queued`) is not idle, and the
      // counters ticking between the two streaming frames are not a new state.
      working: [WORKING],
      turnDone: [IDLE],
      approval: [ASKING],
      afterApproval: [WORKING, IDLE],
    });
  });

  it.each([65536, 97])('reads every state of the 60x30 session (%i-byte reads)', (chunkSize) => {
    const { det, seen } = replay(narrow.frames,
      ['start', 'working', 'turnDone', 'writeApproval', 'afterApproval', 'shellApprovalMidSession', 'afterEsc'], chunkSize);
    expect(det.getLastAgent()).toBe('Qwen Code');
    expect(seen).toEqual({
      start: [STARTED, IDLE],
      working: [WORKING],
      turnDone: [IDLE],
      writeApproval: [WORKING, ASKING],
      afterApproval: [WORKING, IDLE],
      shellApprovalMidSession: [ASKING],
      afterEsc: [IDLE],
    });
  });

  it('knows the pane from the window title once the banner has scrolled off', () => {
    // A detector that first sees the pane mid-session; Gemini's composer row
    // must not claim it either.
    const { det, seen } = replay(narrow.frames, ['shellApprovalMidSession', 'afterEsc'], 65536);
    expect(det.getLastAgent()).toBe('Qwen Code');
    expect(seen).toEqual({ shellApprovalMidSession: [STARTED, ASKING], afterEsc: [IDLE] });
  });

  it('takes the pane back from Gemini when Gemini\'s composer row came first', () => {
    const det = new AgentDetector();
    det.feed('>   Type your message or @path/to/file\r\n');
    expect(det.getLastAgent()).toBe('Gemini CLI');
    const cb = vi.fn();
    det.onEvent(cb);
    det.feed(narrow.frames.shellApprovalMidSession);
    expect(det.getLastAgent()).toBe('Qwen Code');
    expect(cb.mock.calls.map(([e]) => `${e.status}:${e.message}`)).toEqual([STARTED, ASKING]);
  });

  it('does not read the confirmation phrase as a dialog when the spinner keeps it after an answer', () => {
    // The first running frame after an answer can keep the phrase (120x40
    // afterApproval); a narrow pane puts its counters on the next row.
    const { det } = replay(narrow.frames, ['start'], 65536);
    const cb = vi.fn();
    det.onEvent(cb);
    det.resetEmissionState();
    det.feed('\u001b[?2026h  ⠋ Waiting for user confirmation...\r\n  (0s · ↑ 15 tokens · esc to cancel)\r\n'
      + '>   Type your message or @path/to/file\u001b[?2026l');
    expect(cb.mock.calls.map(([e]) => `${e.status}:${e.message}`)).toEqual([WORKING]);
  });

  it('does not open on a title that only starts like Qwen\'s', () => {
    const det = new AgentDetector();
    det.feed('\u001b]2;Qwen - notes.md (~/x) - VIM\u0007\r\n');
    expect(det.getLastAgent()).toBeNull();
  });

  it('does not take a live Claude pane that quotes the banner, the dialog or the footer', () => {
    const det = new AgentDetector();
    const cb = vi.fn();
    det.onEvent(cb);
    det.feed('Claude Code v2.1.172\n  bypass permissions on\n');
    det.feed('│ >_ Qwen Code (v0.26.1)                                   │\n');
    det.feed('  ⠏ Waiting for user confirmation...\n');
    det.feed('  ⏸ Ask permissions (shift + tab to cycle)\n');
    expect(det.getLastAgent()).toBe('Claude Code');
    expect(cb.mock.calls.map(([e]) => e.agent)).not.toContain('Qwen Code');
  });
});
