import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookIngest, type DetectorHeldEventData, type HookAgentEventData, type HookIngestSession } from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

// #1917: Kiro registers exactly two hooks (integrations/kiro/README.md):
// `agentSpawn` → agent.session_start and `stop` → agent.stop, the envelopes
// the shared bridge builds (kiroEnvelope.test.ts). No prompt-submit or
// activity hook, by design. So the only evidence that a Kiro turn ran is the
// screen detector's `running` — and the turn gate announces a stop only after
// such evidence. This pins what the daemon makes of a Kiro pane.
function kiro(kind: AgentSignal['kind'], ts: number): AgentSignal {
  return { kind, agent: 'kiro', ptyId: 'pty-k', cwd: '/repo', payload: {}, ts };
}

describe('a Kiro pane through the shared hook bridge (#1917)', () => {
  let ingest: HookIngest;
  let emitted: Array<{ status: string; decision?: string; hookKind?: string }>;
  let clock = 10_000;
  const settle = () => { vi.advanceTimersByTime(DEFAULT_ALARM_WINDOW_MS + 100); clock += DEFAULT_ALARM_WINDOW_MS + 100; };
  const detectorSeesKiroRun = () => { clock += 1000; ingest.arbitrateDetector('pty-k', { agent: 'Kiro CLI', status: 'running' }); };
  const stop = () => { clock += 1000; expect(ingest.handle(kiro('agent.stop', clock)).ok).toBe(true); settle(); };

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    clock = 10_000;
    const sessions: HookIngestSession[] = [{ id: 'pty-k', cwd: '/repo', env: { WMUX_WORKSPACE_ID: 'ws-1' }, lastActivity: '2026-01-01T00:00:00.000Z' }];
    ingest = new HookIngest({
      listLiveSessions: () => sessions,
      emitAgentEvent: (_id: string, data: HookAgentEventData) => { emitted.push({ status: data.status, decision: data.decision, hookKind: data.hookKind }); },
      emitDetectorEvent: (_id: string, _data: DetectorHeldEventData) => { /* the hook owns this pane's turn end */ },
      applyResumeBinding: () => { /* Kiro sends no session id */ },
      onTranscriptNudge: () => { /* not exercised */ },
      log: () => { /* silent */ },
      now: () => clock,
    });
    expect(ingest.handle(kiro('agent.session_start', clock)).ok).toBe(true);
  });
  afterEach(() => { ingest.dispose(); vi.useRealTimers(); });

  it('agentSpawn reads as working, and a stop after a turn the detector saw is announced done', () => {
    detectorSeesKiroRun();
    stop();
    expect(emitted).toEqual([
      { status: 'running', decision: 'activity', hookKind: 'agent.session_start' },
      { status: 'complete', decision: 'emit', hookKind: 'agent.stop' },
    ]);
  });

  it('announces each turn of a session', () => {
    detectorSeesKiroRun();
    stop();
    detectorSeesKiroRun();
    stop();
    expect(emitted.filter((e) => e.hookKind === 'agent.stop').map((e) => e.decision)).toEqual(['emit', 'emit']);
  });

  it('does not announce a stop with no evidence that a turn ran since the last boundary', () => {
    stop();
    detectorSeesKiroRun();
    stop();
    stop();
    expect(emitted.filter((e) => e.hookKind === 'agent.stop').map((e) => e.decision)).toEqual(['internal', 'emit', 'internal']);
  });
});
