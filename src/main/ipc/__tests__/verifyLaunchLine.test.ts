// F26 — a fan-out task pane's launch line is checked after it was written,
// and written once more when the shell never read it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyLaunchLine, type LaunchLineRead, type LaunchLineOutcome } from '../handlers/verifyLaunchLine';

const atPrompt = (total: number): LaunchLineRead => ({
  sessionFound: true,
  totalBytesWritten: total,
  events: [
    { type: 'command_end', byteOffset: 40 },
    { type: 'prompt_start', byteOffset: 40 },
    { type: 'prompt_end', byteOffset: 180 },
  ],
});
const withRead = (total: number): LaunchLineRead => {
  const r = atPrompt(total);
  return { ...r, events: [...r.events, { type: 'command_start', byteOffset: 300 }] };
};

function run(reads: () => LaunchLineRead | null) {
  const resend = vi.fn(() => true);
  let outcome: LaunchLineOutcome | undefined;
  verifyLaunchLine({
    read: async () => reads(),
    resend,
    pollMs: 100,
    quietMs: 1_000,
    windowMs: 10_000,
    onDone: (o) => { outcome = o; },
  });
  return { resend, outcome: () => outcome };
}

describe('verifyLaunchLine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the line once more when the shell sits at its prompt and never read it', async () => {
    const v = run(() => atPrompt(180));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(v.resend).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as the shell has read the line, and never re-sends', async () => {
    const v = run(() => withRead(400));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('read');
  });

  it('re-sends at most once, then gives up', async () => {
    const v = run(() => atPrompt(180));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).toHaveBeenCalledTimes(1);
    expect(v.outcome()).toBe('gave-up');
  });

  it('reports the re-sent line once the shell read it', async () => {
    let n = 0;
    const v = run(() => (v.resend.mock.calls.length > 0 && ++n > 1 ? withRead(500) : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).toHaveBeenCalledTimes(1);
    expect(v.outcome()).toBe('resent');
  });

  it('never re-sends while the pane keeps writing', async () => {
    // A program running under a shell that shows no command-start.
    let total = 180;
    const v = run(() => atPrompt((total += 50)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('no-evidence');
  });

  it('never re-sends into a pane with no prompt markers, or whose reads fail', async () => {
    const none = run(() => ({ sessionFound: true, totalBytesWritten: 0, events: [] }));
    const failing = run(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(none.resend).not.toHaveBeenCalled();
    expect(failing.resend).not.toHaveBeenCalled();
    expect(none.outcome()).toBe('no-evidence');
  });

  it('stops for a session that is gone', async () => {
    const v = run(() => ({ sessionFound: false, totalBytesWritten: 0, events: [] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(v.outcome()).toBe('gone');
    expect(v.resend).not.toHaveBeenCalled();
  });
});
