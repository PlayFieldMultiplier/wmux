// A Claude PermissionRequest's attention alarm asks the screen before it
// confirms: no dialog on a readable grid, twice, means nothing to answer, and
// the "needs you" broadcast is dropped. Reported as a toast every ~2 s while
// the agent visibly kept working (background-agent permissions, auto-resolved
// prompts, dialogs answered inside the window).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookIngest, DIALOG_RECHECK_MS, type HookAgentEventData, type HookIngestDeps, type HookIngestSession } from '../HookIngest';
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
  const awaiting = () => emitted.filter((e) => e.status === 'awaiting_input');
  return { ingest, emitted, logs, awaiting, advance: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
}

async function settle(): Promise<void> {
  // The screen check resolves on the microtask queue after the window timer.
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Confirm the window, then let the first read and the re-read both run. */
async function confirmAndRecheck(f: ReturnType<typeof makeIngest>): Promise<void> {
  f.advance(DEFAULT_ALARM_WINDOW_MS);
  await settle();
  f.advance(DIALOG_RECHECK_MS);
  await settle();
}

describe('HookIngest — PermissionRequest alarm checks the screen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops the awaiting_input broadcast when no dialog is on screen at confirmation AND on the re-read', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    expect(f.emitted).toEqual([]);
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    // One miss is not enough: nothing sent, nothing dropped yet.
    expect(screen).toHaveBeenCalledTimes(1);
    expect(f.awaiting()).toEqual([]);
    expect(f.logs.some((l) => l.includes('dropped'))).toBe(false);
    f.advance(DIALOG_RECHECK_MS);
    await settle();
    expect(screen).toHaveBeenCalledTimes(2);
    expect(f.awaiting()).toEqual([]);
    expect(f.logs.some((l) => l.includes('dropped: no dialog on screen'))).toBe(true);
  });

  it('five hooks in a row with no dialog produce zero toasts, not five', async () => {
    const f = makeIngest(async () => false);
    for (let i = 0; i < 5; i++) {
      f.ingest.handle(makeSignal({ ts: 1_000 + i * 2_000 }));
      // tool output keeps arriving between them
      f.advance(500);
      f.ingest.handle(makeSignal({ kind: 'agent.activity', payload: {}, ts: 1_500 + i * 2_000 }));
      f.advance(1_500);
      await settle();
    }
    await confirmAndRecheck(f);
    expect(f.awaiting()).toEqual([]);
  });

  it('broadcasts when the dialog IS on screen', async () => {
    const f = makeIngest(async () => true);
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });

  it('a dialog drawn late (slow third-party hook) is caught by the re-read', async () => {
    let drawn = false;
    const screen = vi.fn(async () => drawn);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toEqual([]);
    drawn = true;
    f.advance(DIALOG_RECHECK_MS);
    await settle();
    expect(screen).toHaveBeenCalledTimes(2);
    expect(f.awaiting()).toHaveLength(1);
  });

  it('stands down when the dialog was answered or the turn ended while the screen read was in flight', async () => {
    for (const settleWith of [
      makeSignal({ kind: 'agent.permission_answered', payload: {}, ts: 2_000 }),
      makeSignal({ kind: 'agent.stop', payload: {}, ts: 2_000 }),
      makeSignal({ kind: 'agent.user_prompt_submit', payload: {}, ts: 2_000 }),
    ]) {
      let resolve: (up: boolean | null) => void = () => undefined;
      const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
      f.ingest.handle(makeSignal());
      f.advance(DEFAULT_ALARM_WINDOW_MS);
      await settle();
      // The read is pending; the dialog gets settled meanwhile.
      f.ingest.handle(settleWith);
      resolve(true);
      await settle();
      expect(f.awaiting(), settleWith.kind).toEqual([]);
      expect(f.logs.some((l) => l.includes('stood down')), settleWith.kind).toBe(true);
    }
  });

  it('working evidence (a subagent\'s PostToolUse, SubagentStop, another PermissionRequest) does NOT stand the alert down', async () => {
    for (const other of [
      makeSignal({ kind: 'agent.activity', payload: {}, ts: 2_000 }),
      makeSignal({ kind: 'agent.subagent_stop', payload: {}, ts: 2_000 }),
      makeSignal({ kind: 'agent.tool_started', payload: {}, ts: 2_000 }),
    ]) {
      let resolve: (up: boolean | null) => void = () => undefined;
      const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
      f.ingest.handle(makeSignal());
      f.advance(DEFAULT_ALARM_WINDOW_MS);
      await settle();
      f.ingest.handle(other);
      resolve(true);
      await settle();
      expect(f.awaiting(), other.kind).toHaveLength(1);
    }
  });

  it('a pane dropped during the read never gets a broadcast (fresh pane, first ever hook)', async () => {
    let resolve: (up: boolean | null) => void = () => undefined;
    const f = makeIngest(() => new Promise<boolean | null>((r) => { resolve = r; }));
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    f.ingest.dropPty('pty-a');
    resolve(true);
    await settle();
    expect(f.awaiting()).toEqual([]);
  });

  it('a reader that resolves on a timer (the snapshot queue) still honours an answer that arrived first', async () => {
    const f = makeIngest(() => new Promise<boolean | null>((r) => { setTimeout(() => r(true), 400); }));
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    f.ingest.handle(makeSignal({ kind: 'agent.permission_answered', payload: {}, ts: 2_000 }));
    f.advance(400);
    await settle();
    expect(f.awaiting()).toEqual([]);

    const g = makeIngest(() => new Promise<boolean | null>((r) => { setTimeout(() => r(true), 400); }));
    g.ingest.handle(makeSignal());
    g.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    g.advance(400);
    await settle();
    expect(g.awaiting()).toHaveLength(1);
  });

  it('a stale re-read never fires after the dialog was settled', async () => {
    const screen = vi.fn(async () => true);
    let first = true;
    const f = makeIngest(async () => { if (first) { first = false; return false; } return screen(); });
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    f.ingest.handle(makeSignal({ kind: 'agent.permission_answered', payload: {}, ts: 2_000 }));
    f.advance(DIALOG_RECHECK_MS);
    await settle();
    expect(screen).not.toHaveBeenCalled();
    expect(f.awaiting()).toEqual([]);
  });

  it('trusts the hook when the grid is unreadable (null), the check rejects, or the check throws synchronously', async () => {
    const a = makeIngest(async () => null);
    a.ingest.handle(makeSignal());
    a.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(a.awaiting()).toHaveLength(1);

    const b = makeIngest(async () => { throw new Error('render failed'); });
    b.ingest.handle(makeSignal());
    b.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(b.awaiting()).toHaveLength(1);

    const c = makeIngest(() => { throw new Error('sync'); });
    c.ingest.handle(makeSignal());
    c.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(c.awaiting()).toHaveLength(1);
  });

  it('a throwing fan-out is logged once, not retried through the error path', async () => {
    const f = makeIngest(async () => true);
    let calls = 0;
    (f.ingest as unknown as { deps: HookIngestDeps }).deps.emitAgentEvent = () => { calls++; throw new Error('consumer threw'); };
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    // Exactly one delivery attempt: the error path must not run fanOut again.
    expect(calls).toBe(1);
  });

  it('does not consult the screen for AskUserQuestion or non-Claude agents', async () => {
    const screen = vi.fn(async () => false);
    const f = makeIngest(screen);
    f.ingest.handle(makeSignal({ payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' } }));
    f.ingest.handle(makeSignal({ agent: 'codex', ptyId: 'pty-a' }));
    await confirmAndRecheck(f);
    expect(screen).not.toHaveBeenCalled();
  });

  it('behaves as before when no screen reader is supplied', async () => {
    const f = makeIngest();
    f.ingest.handle(makeSignal());
    f.advance(DEFAULT_ALARM_WINDOW_MS);
    await settle();
    expect(f.awaiting()).toHaveLength(1);
  });
});
