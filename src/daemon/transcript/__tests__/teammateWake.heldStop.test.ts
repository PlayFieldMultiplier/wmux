// A woken lead turn after a Stop the completion alarm holds (#2494).
// HookIngest, its alarm and a real DaemonPTYBridge are wired to TeammateWakes
// the way the daemon wires them: hook signals reach the module through the
// transcript nudge, turn ends through the applied broadcast (turnEndAt).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { HookIngest } from '../../hooks/HookIngest';
import { DaemonPTYBridge } from '../../DaemonPTYBridge';
import { PromptEventLog } from '../../PromptEventLog';
import { RingBuffer } from '../../RingBuffer';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import { TeammateWakes, turnEndAt } from '../teammateWake';

const PATH = '/home/u/.claude/projects/p/lead.jsonl';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

const wakeLine = (uuid: string, at: number): string => JSON.stringify({
  parentUuid: 'p', isSidechain: false, type: 'user', uuid, timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="sleeper">\ndone sleeping\n</teammate-message>' },
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('TeammateWakes — a turn end the completion alarm holds', () => {
  let bridge: DaemonPTYBridge;
  let ingest: HookIngest;
  let wakes: TeammateWakes;
  let order: string[];

  const signal = (kind: AgentSignal['kind'], ts = Date.now()): AgentSignal =>
    ({ kind, agent: 'claude', cwd: '/repo', ptyId: 'pty-a', payload: {}, ts });

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'pty-a', new PromptEventLog());
    order = [];
    wakes = new TeammateWakes({
      isReader: () => true,
      mayOpen: () => !bridge.isAwaitingHuman(),
      emit: (_id, at) => {
        order.push('wake');
        bridge.noteAgentStatus('running', true, undefined, false, at);
      },
      defer: (fn) => { void Promise.resolve().then(fn); },
    });
    ingest = new HookIngest({
      listLiveSessions: () => [{ id: 'pty-a', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' }, lastActivity: '2026-01-01T00:00:00.000Z' }],
      emitAgentEvent: (id, data) => {
        bridge.noteAgentStatus(data.status, true, undefined, false, data.signal.ts);
        order.push(data.status);
        const end = turnEndAt(data);
        if (end !== undefined) wakes.noteTurnEnd(id, end);
      },
      onTranscriptNudge: (id, kind, _agentSessionId, ts) => wakes.noteHookSignal(id, kind, ts),
      applyResumeBinding: () => undefined,
      log: () => undefined,
      latestEndedTurn: () => bridge.endedTurnId(),
    });
  });

  afterEach(() => {
    ingest.dispose();
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('opens the woken turn after the held Stop lands, so that Stop does not close it', async () => {
    // Turn N: a prompt, then a tool, so its Stop is held for the alarm window.
    ingest.handle(signal('agent.user_prompt_submit'));
    vi.advanceTimersByTime(200);
    ingest.handle(signal('agent.tool_started'));
    vi.advanceTimersByTime(3_000);
    const stopAt = Date.now();
    ingest.handle(signal('agent.stop', stopAt));
    expect(order).not.toContain('complete');

    // The teammate's queued message is written 15 ms after that Stop fired.
    vi.advanceTimersByTime(15);
    wakes.noteLine('pty-a', PATH, wakeLine('u-wake', Date.now()));
    await flush();
    // Not yet: the Stop it follows has not landed.
    expect(order).not.toContain('wake');

    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    await flush();
    expect(order.slice(-2)).toEqual(['complete', 'wake']);
    // The woken turn is open, and only its own Stop closes it.
    expect(bridge.isTurnOpen()).toBe(true);
    ingest.handle(signal('agent.stop'));
    vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS);
    await flush();
    expect(bridge.isTurnOpen()).toBe(false);
  });
});
