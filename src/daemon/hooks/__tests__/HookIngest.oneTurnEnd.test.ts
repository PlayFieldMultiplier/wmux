// One turn has one end. A turn end that arrives after its turn already ended
// is dropped at intake, keyed on the daemon's own episode id, never on time:
// the real StopFailure after the transcript's stand-in for it
// (daemon/transcript/apiErrorTurnEnd), and the stand-in after the real hook.
// HookIngest is wired to a real DaemonPTYBridge the way the daemon wires them:
// every broadcast settles the bridge through noteAgentStatus.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { HookIngest, type HookAgentEventData } from '../HookIngest';
import { DaemonPTYBridge } from '../../DaemonPTYBridge';
import { PromptEventLog } from '../../PromptEventLog';
import { RingBuffer } from '../../RingBuffer';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('HookIngest — one turn, one end', () => {
  let bridge: DaemonPTYBridge;
  let ingest: HookIngest;
  let emitted: HookAgentEventData[];

  const signal = (kind: AgentSignal['kind'], ts = Date.now(), payload: Record<string, unknown> = {}): AgentSignal =>
    ({ kind, agent: 'claude', cwd: '/repo', ptyId: 'pty-a', payload, ts });
  const failure = (ts = Date.now()) => signal('agent.stop_failure', ts, { error: 'oauth_org_not_allowed', last_assistant_message: 'disabled' });
  const ends = () => emitted.filter((e) => e.signal.kind === 'agent.stop_failure' || e.signal.kind === 'agent.stop');

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'pty-a', new PromptEventLog());
    emitted = [];
    ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' }, lastActivity: '2026-01-01T00:00:00.000Z' }],
      emitAgentEvent: (_id, data) => {
        emitted.push(data);
        if (data.status === 'running' || data.status === 'complete' || data.status === 'error' || data.status === 'awaiting_input') {
          bridge.noteAgentStatus(data.status, true, undefined, false, data.signal.ts);
        }
      },
      log: () => undefined,
      endedTurnAt: (_id, ts) => bridge.endedTurnAt(ts),
      turnIdAt: (_id, ts) => bridge.turnAt(ts)?.turnId,
    });
  });

  afterEach(() => {
    ingest.dispose();
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('drops the real StopFailure that lands after the transcript already ended the turn', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    const firedAt = Date.now() + 500;
    vi.advanceTimersByTime(5_500);
    // The stand-in, sent after the grace.
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(bridge.isTurnOpen()).toBe(false);
    // The real hook, slow to start, fired with the error and arrives now.
    vi.advanceTimersByTime(1_500);
    ingest.handle(failure(firedAt));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(1);
  });

  it('drops the stand-in that lands after the real StopFailure ended the turn', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    vi.advanceTimersByTime(5_000);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(1);
  });

  it('lets the next turn end through: the key is the turn, not a time window', () => {
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(500);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    // A new prompt opens a new episode right away; its own failure is an end.
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(300);
    ingest.handle(failure());
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    expect(ends()).toHaveLength(2);
  });
});
