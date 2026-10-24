// #2673 — Claude Code relaunched in a pane that already ran it (`/exit`, then
// `claude` again). The tracker still watched the previous Claude's pid, which
// the process monitor reported dead a few seconds after the new splash had
// opened the detector gate. That death edge ended the pane's agent: it cleared
// the new launch's screen identity, and with no live edge for the new process
// nothing opened the gate again. The new turn's "Interrupted" row was never
// read, so Esc settled nothing (Windows, 11 instrumented runs).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { AgentProcessTracker, type PidWatcher, type ProcessTreeEntry } from '../AgentProcessTracker';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import { RESIZE_REDRAW_GUARD_MS } from '../../main/notification/idleSuppression';

const PROMPT = '\x1b]133;A\x07$ \x1b]133;B\x07';
const COMMAND_START = '\x1b]133;C\x07';
const SHELL_RETURN = '\x1b]133;D;0\x07' + PROMPT;
const SPLASH = 'Claude Code v2.1.310\r\n  bypass permissions on\r\n';
const ROW = '  ⎿  Interrupted · What should Claude do instead?\r\n';
const SHELL_PID = 100;

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

describe('a relaunched Claude Code keeps its identity through its predecessor\'s death edge', () => {
  let bridge: DaemonPTYBridge;
  let pty: ReturnType<typeof fakePty>;
  let tracker: AgentProcessTracker;
  let processes: ProcessTreeEntry[];
  let onDead: Map<number, () => void>;
  let interrupted: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    bridge = new DaemonPTYBridge();
    pty = fakePty();
    bridge.setupDataForwarding(pty.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
    interrupted = 0;
    bridge.on('turnInterrupted', () => { interrupted += 1; });
    processes = [];
    onDead = new Map();
    const watcher: PidWatcher = {
      watch: (_key, pid, dead) => { onDead.set(pid, dead); },
      unwatch: () => undefined,
    };
    tracker = new AgentProcessTracker(watcher, async () => processes);
    // The daemon's wiring (index.ts): the guard captures the detector epoch,
    // and every state change reaches the bridge.
    tracker.setIdentityProbeGuard(() => bridge.captureIdentityProbe());
    tracker.setStateChangeListener((_id, state) => bridge.noteAgentProcess(state));
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    tracker.disarm('pane-a');
    bridge.cleanup();
    vi.useRealTimers();
  });

  /** `claude` typed at the shell prompt; `together` = OSC 133;C and the splash in one read. */
  function launch(together: boolean): void {
    bridge.noteInput('claude\r');
    if (together) {
      pty.feed(COMMAND_START + SPLASH);
    } else {
      pty.feed(COMMAND_START);
      vi.advanceTimersByTime(300);
      pty.feed(SPLASH);
    }
  }

  /** Launch the first Claude and let the tracker pick its process (pid 200). */
  async function firstClaudeThenExit(): Promise<void> {
    pty.feed(PROMPT);
    launch(false);
    processes = [{ pid: SHELL_PID, ppid: 1, name: 'zsh' }, { pid: 200, ppid: SHELL_PID, name: 'claude' }];
    tracker.arm('pane-a', SHELL_PID);
    await vi.waitFor(() => expect(tracker.statusFor('pane-a')).toBe(true), { timeout: 5_000 });
    bridge.noteInput('/exit\r');
    processes = [{ pid: SHELL_PID, ppid: 1, name: 'zsh' }];
    pty.feed(SHELL_RETURN);
    vi.advanceTimersByTime(1000);
  }

  /** Esc during a turn, and the agent's own row confirming it. */
  function escAndRow(): void {
    vi.advanceTimersByTime(RESIZE_REDRAW_GUARD_MS);
    bridge.noteInput('reply hi\r');
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b');
    vi.advanceTimersByTime(250);
    pty.feed(ROW);
  }

  it.each([
    ['in separate reads', false],
    ['in one read', true],
  ])('the late death edge of the previous Claude leaves the new splash\'s gate open (command start and splash %s)', async (_label, together) => {
    await firstClaudeThenExit();
    launch(together);
    expect(bridge.getLastAgent()).toBe('Claude Code');

    onDead.get(200)?.(); // the monitor reports the previous Claude dead
    expect(bridge.getLastAgent()).toBe('Claude Code');

    escAndRow();
    expect(interrupted).toBe(1);
  });

  it('a relaunch known only by its own hook keeps that identity through the late death edge', async () => {
    await firstClaudeThenExit();
    bridge.noteInput('claude --permission-mode default\r');
    pty.feed(COMMAND_START); // no splash the gate reads
    vi.advanceTimersByTime(300);
    const seeded = bridge.noteHookAgentIdentity(
      { kind: 'agent.session_start', agent: 'claude', ptyId: 'pane-a', cwd: '/repo', ts: Date.now(), payload: {} },
      { slug: 'claude', source: 'hook' },
    );
    expect(seeded).toBe(true);

    const detector = (bridge as unknown as { agentDetector: { getTrustedAgent(): string | null } }).agentDetector;
    expect(detector.getTrustedAgent()).toBe('claude');
    onDead.get(200)?.();
    expect(detector.getTrustedAgent()).toBe('claude');
  });

  it('the previous Claude dying before the relaunch leaves the new launch to its own splash', async () => {
    await firstClaudeThenExit();
    onDead.get(200)?.();
    launch(false);
    expect(bridge.getLastAgent()).toBe('Claude Code');
    escAndRow();
    expect(interrupted).toBe(1);
  });

  it('the death of the Claude the pane still runs ends it', async () => {
    pty.feed(PROMPT);
    launch(false);
    processes = [{ pid: SHELL_PID, ppid: 1, name: 'zsh' }, { pid: 200, ppid: SHELL_PID, name: 'claude' }];
    tracker.arm('pane-a', SHELL_PID);
    await vi.waitFor(() => expect(tracker.statusFor('pane-a')).toBe(true), { timeout: 5_000 });
    expect(bridge.getLastAgent()).toBe('Claude Code');
    onDead.get(200)?.(); // killed, with no shell return yet
    expect(bridge.getLastAgent()).toBeNull();
  });
});
