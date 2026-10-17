// F26 — a fan-out task pane's launch line is checked after it was written,
// and written once more only on positive evidence that it never arrived.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyLaunchLine, type LaunchLineRead, type LaunchLineOutcome } from '../handlers/verifyLaunchLine';

/** bash at a prompt (`D;$? A`, PS1 ending in B at `promptAt`), `total` bytes out. */
const atPrompt = (total: number, promptAt = 180): LaunchLineRead => ({
  sessionFound: true,
  totalBytesWritten: total,
  events: [
    { type: 'command_end', byteOffset: 40 },
    { type: 'prompt_start', byteOffset: 40 },
    { type: 'prompt_end', byteOffset: promptAt },
  ],
});
const withRead = (total: number): LaunchLineRead => {
  const r = atPrompt(total);
  return { ...r, events: [...r.events, { type: 'command_start', byteOffset: 300 }] };
};
/** Before the shell drew anything but ConPTY's preamble. */
const booting: LaunchLineRead = { sessionFound: true, totalBytesWritten: 24, events: [] };

function run(reads: (call: number) => LaunchLineRead | null, nothingRunning = true) {
  const resend = vi.fn(() => true);
  const running = vi.fn(async () => nothingRunning);
  let outcome: LaunchLineOutcome | undefined;
  let call = 0;
  verifyLaunchLine({
    read: async () => reads(call++),
    resend,
    nothingRunning: running,
    pollMs: 100,
    quietMs: 1_000,
    windowMs: 10_000,
    onDone: (o) => { outcome = o; },
  });
  return { resend, running, outcome: () => outcome };
}

describe('verifyLaunchLine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the line once more when the shell drew its prompt after the line and never read it', async () => {
    // WSL under load: the line was typed while the distro was still starting.
    const v = run((n) => (n === 0 ? booting : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(v.running).toHaveBeenCalled();
    expect(v.resend).toHaveBeenCalledTimes(1);
  });

  it('never re-sends into a shell without command-start whose launched program has gone quiet', async () => {
    // macOS /bin/bash 3.2: prompt markers but no C. The prompt was drawn
    // before the line; bash read it, echoed it and runs it, and the program
    // then writes nothing. Its last marker is still that prompt.
    const v = run((n) => (n === 0 ? atPrompt(180) : atPrompt(420)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('unverified');
  });

  it('never re-sends on a prompt drawn before the line, even with nothing written since', async () => {
    const v = run(() => atPrompt(180));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('unverified');
  });

  it('never re-sends when the daemon cannot say that nothing runs in the pane', async () => {
    const v = run((n) => (n === 0 ? booting : atPrompt(180)), false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.running).toHaveBeenCalled();
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('unverified');
  });

  it('never re-sends when the line was echoed after a fresh prompt', async () => {
    // The typed-ahead line reached bash after its prompt: the echo is output.
    const v = run((n) => (n === 0 ? booting : atPrompt(180 + 120)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
  });

  it('stops as soon as the shell shows it read the line (command-start), and never re-sends', async () => {
    const v = run((n) => (n === 0 ? booting : withRead(400)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).not.toHaveBeenCalled();
    expect(v.outcome()).toBe('read');
  });

  it('re-sends at most once, then gives up', async () => {
    const v = run((n) => (n === 0 ? booting : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).toHaveBeenCalledTimes(1);
    expect(v.outcome()).toBe('gave-up');
  });

  it('reports the re-sent line once the shell read it', async () => {
    const v: ReturnType<typeof run> = run((n) => (n === 0 ? booting : v.resend.mock.calls.length > 0 ? withRead(500) : atPrompt(180)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(v.resend).toHaveBeenCalledTimes(1);
    expect(v.outcome()).toBe('resent');
  });

  it('never re-sends into a pane with no prompt markers, or whose reads fail', async () => {
    const none = run(() => ({ sessionFound: true, totalBytesWritten: 0, events: [] }));
    const failing = run(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(none.resend).not.toHaveBeenCalled();
    expect(failing.resend).not.toHaveBeenCalled();
    expect(none.outcome()).toBe('unverified');
  });

  it('stops for a session that is gone', async () => {
    const v = run(() => ({ sessionFound: false, totalBytesWritten: 0, events: [] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(v.outcome()).toBe('gone');
    expect(v.resend).not.toHaveBeenCalled();
  });
});
