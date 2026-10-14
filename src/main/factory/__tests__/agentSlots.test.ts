// One budget for bots and workers: a bot's new worker past it waits for a
// slot, first come first served, and a stop ends the wait.
import { describe, expect, it, vi } from 'vitest';
import { AgentSlots, SLOT_GRANT_MAX_MS, type AgentSlotPorts } from '../agentSlots';

function slots(over: Partial<AgentSlotPorts> & { bots?: () => number; workers?: () => number } = {}) {
  let now = 0;
  const onWaiting = vi.fn();
  const s = new AgentSlots({
    cap: () => 3,
    runningBots: over.bots ?? (() => 1),
    liveWorkers: over.workers ?? (() => 0),
    onWaiting,
    now: () => now,
    pollMs: 60_000,
    ...over,
  });
  return { s, onWaiting, advance: (ms: number) => { now += ms; } };
}
const w = (taskId: string) => ({ taskId, title: taskId, botId: 'bot-0000000a', ownerWorkspaceId: 'ws-1' });

describe('AgentSlots', () => {
  it('grants under the cap and counts granted launches until they register', async () => {
    let workers = 0;
    const { s, onWaiting } = slots({ workers: () => workers });
    const a = await s.acquire(w('a'));
    const b = await s.acquire(w('b'));
    expect(a.ok && b.ok).toBe(true);
    expect(s.inUse()).toBe(3); // 1 bot + 2 granted
    let third: unknown = null;
    void s.acquire(w('c')).then((g) => { third = g; });
    await Promise.resolve();
    expect(third).toBeNull();
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(s.waiting().map((x) => x.taskId)).toEqual(['c']);
    // a registers: counted as a live worker, its booking released; still full.
    workers = 1;
    if (a.ok) a.release();
    await Promise.resolve();
    expect(third).toBeNull();
    // b's launch gives up: a slot frees and c starts.
    if (b.ok) b.release();
    await vi.waitFor(() => expect(third).toMatchObject({ ok: true }));
    expect(s.waiting()).toEqual([]);
  });

  it('serves waiters in order, and a new start never jumps the queue', async () => {
    let bots = 3;
    const { s } = slots({ bots: () => bots });
    const order: string[] = [];
    void s.acquire(w('first')).then(() => order.push('first'));
    void s.acquire(w('second')).then(() => order.push('second'));
    bots = 2;
    expect(s.tryAcquire()).toBeNull(); // others wait first
    s.kick();
    await vi.waitFor(() => expect(order).toEqual(['first']));
    bots = 1;
    s.kick();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
  });

  it('ends a wait unlaunched when the launch is no longer wanted, or after the longest wait', async () => {
    const { s, advance } = slots({ bots: () => 3, maxWaitMs: 1_000 });
    let stopped: string | null = null;
    const a = s.acquire(w('a'), () => stopped);
    const b = s.acquire(w('b'));
    stopped = 'the owner stopped this bot';
    s.kick();
    expect(await a).toEqual({ ok: false, reason: 'the owner stopped this bot' });
    advance(1_000);
    s.kick();
    expect(await b).toMatchObject({ ok: false });
  });

  it('a broken count or cap never grants past one agent', async () => {
    const { s } = slots({ cap: () => Number.NaN, bots: () => 0 });
    expect((await s.acquire(w('a'))).ok).toBe(true);
    expect(s.tryAcquire()).toBeNull();
    s.dispose();
    expect(await s.acquire(w('b'))).toMatchObject({ ok: false });
  });
});

describe('AgentSlots held workers', () => {
  it('a spawned worker with no ledger row keeps its slot while its workspace lives', async () => {
    const live = new Set<string>();
    const { s } = slots({ bots: () => 0, stillHeld: (ws) => live.has(ws) });
    const g = await s.acquire(w('a'));
    if (!g.ok) throw new Error('no grant');
    live.add('ws-task');
    g.hold('ws-task');
    expect(s.inUse()).toBe(1);
    g.release(); // already handed over: no double release
    expect(s.inUse()).toBe(1);
    live.delete('ws-task');
    expect(s.inUse()).toBe(0);
  });

  it('without a way to tell, a hold releases the slot', async () => {
    const { s } = slots({ bots: () => 0 });
    const g = await s.acquire(w('a'));
    if (g.ok) g.hold('ws-task');
    expect(s.inUse()).toBe(0);
  });
});

describe('AgentSlots grants (review fixes, PR #2164)', () => {
  it('a grant neither released nor held stops counting after SLOT_GRANT_MAX_MS', async () => {
    const { s, advance } = slots({ bots: () => 0, log: () => undefined });
    const g = await s.acquire(w('a'));
    expect(g.ok).toBe(true);
    expect(s.inUse()).toBe(1);
    advance(SLOT_GRANT_MAX_MS - 1);
    expect(s.inUse()).toBe(1);
    advance(1);
    expect(s.inUse()).toBe(0);
    // A late release of it changes nothing.
    if (g.ok) g.release();
    expect(s.inUse()).toBe(0);
  });

  it('lists a bot\'s launches under way: waiting or granted, until released', async () => {
    const { s } = slots({ bots: () => 0 });
    const a = await s.acquire(w('a'));
    await s.acquire({ ...w('x'), botId: 'bot-0000000b' });
    const b = await s.acquire(w('b'));
    void s.acquire(w('c'));
    await Promise.resolve();
    expect(s.inFlight('bot-0000000a').sort()).toEqual(['a', 'b', 'c']);
    if (a.ok) a.release();
    if (b.ok) b.hold('ws-b');
    await Promise.resolve();
    expect(s.inFlight('bot-0000000a')).toEqual(['c']);
  });
});
