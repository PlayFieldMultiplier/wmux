// A Claude PermissionRequest's attention alarm asks the screen before it
// confirms: no dialog on a readable grid means nothing to answer, and the
// "needs you" broadcast is dropped. Reported as a toast every ~2 s while the
// agent visibly kept working (background-agent permissions, auto-resolved
// prompts, dialogs answered inside the window).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookIngest, type HookAgentEventData, type HookIngestDeps, type HookIngestSession } from '../HookIngest';
import { DEFAULT_ALARM_WINDOW_MS } from '../../../shared/hooks/CompletionAlarm';
import type { AgentSignal } from '../../../shared/hooks/signal-types';

const PERMISSION_REQUEST = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
};

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return { kind: 'agent.awaiting_input', agent: 'claude', cwd: '/repo', payload: PERMISSION_REQUEST, ts: 1_000, ptyId: 'pty-a', ...overrides };
}

function makeIngest(dialogOnScreen?: HookIngestDeps['dialogOnScreen']) {
  const sessions: HookIngestSession[] = [{ id: 'pty-a', cwd: '/repo', env: {} }];
  const emitted: HookAgentEventData[] = [];
  const logs: string[] = [];
  let clock = 10_000;
  const deps: HookIngestDeps = {
    listLiveSessions: () => sessions,
    emitAgentEvent: (_id, data) => { emitted.push(data); },
    applyResumeBinding: () => undefined,
    log: (_level, message) => { logs.push(message); },
    now: () => clock,
    ...(dialogOnScreen ? { dialogOnScreen } : {}),
  };
  const ingest = new HookIngest(deps);
  return { ingest, emitted, logs, advance: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
}

async function settle(): Promise<void> {
  // The screen check resolves on the microtask queue after the window timer.
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('HookIngest — PermissionRequest alarm checks the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops the awaiting_input broadcast when no dialog is on screen at confirmation', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    expect(f.emitted).toEqual([]);
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(screen).toHaveBeenCalledWith('pty-a');
    expect(f.emitted.filter((e) => e.status === 'awaiting_input')).toEqual([]);
    expect(f.logs.some((l) => l.includes('no dialog on screen'))).toBe(true);
  });

  it('five hooks in a row with no dialog produce zero toasts, not five', async () => {
    const f = makeIngest(async () => false);
    for (let i = 0; i < 5; i++) {
      f.ingest.handle(makeSignal({ ts: 1_000 + i * 2_000 }));
      // tool output keeps arriving between them
      f.advance(500);
      f.ingest.handle(makeSignal({ kind: 'agent.activity', payload: {}, ts: 1_500 + i * 2_000 }));
      f.advance(1_500);
    }
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.emitted.filter((e) => e.status === 'awaiting_input')).toEqual([]);
  });

  it('broadcasts when the dialog IS on screen', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.emitted.filter((e) => e.status === 'awaiting_input')).toHaveLength(1);
  });

  it('trusts the hook when the grid is unreadable (null) or the check throws', async () => {
    const a = makeIngest(async () => null);
    a.ingest.handle(makeSignal());
    a.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(a.emitted.filter((e) => e.status === 'awaiting_input')).toHaveLength(1);

    const b = makeIngest(async () => { throw new Error('render failed'); });
    b.ingest.handle(makeSignal());
    b.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(b.emitted.filter((e) => e.status === 'awaiting_input')).toHaveLength(1);
  });

  it('does not consult the screen for AskUserQuestion or non-Claude agents', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal({ payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' } }));
    f.ingest.handle(makeSignal({ agent: 'codex', ptyId: 'pty-a' }));
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(screen).not.toHaveBeenCalled();
  });

  it('behaves as before when no screen reader is supplied', async () => {
    const f = makeIngest();
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.emitted.filter((e) => e.status === 'awaiting_input')).toHaveLength(1);
  });
});
