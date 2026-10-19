// A bot's fan-out refused only for a worker slot is held, and the bot is
// woken with it once a slot frees: through AgentSlots.kick() (a task ended,
// a worker stopped) or a holder record's change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSlots } from '../agentSlots';
import { HELD_PER_BOT_MAX, HeldFanouts, heldWakeIsFor, installHeldFanoutReleases, releaseHeldFanouts, setHeldFanouts, type HeldFanoutPorts } from '../heldFanouts';
import { holderInputsChanged } from '../holderInputs';
import { __resetRedactedSecretsForTesting, setRedactedSecrets } from '../secretRedaction';
import { WakeQueue, dropQueuedHeldFanoutWakes, setWakeQueue, wakeQueuePath } from '../wakeQueue';

const BOT_A = 'bot-0000000a';
const BOT_B = 'bot-0000000b';
const SHA = 'a'.repeat(40);

function rig(dir: string) {
  const open = new Map<string, number>();
  const factory = (): number => [...open.values()].reduce((a, b) => a + b, 0);
  const queue = new WakeQueue(wakeQueuePath(dir));
  queue.load();
  const ports: HeldFanoutPorts = {
    budget: () => ({ maxConcurrentWorkers: 1 }),
    openWorkers: (botId) => ({ bot: open.get(botId) ?? 0, factory: factory() }),
    // The wake file's write is the queue's own (botStores tests): taken as done.
    wakes: () => ({ enqueue: (input) => queue.enqueue(input), flush: () => Promise.resolve() }),
  };
  const held = HeldFanouts.at(dir, ports);
  held.load();
  setHeldFanouts(held);
  return { open, queue, held, ports };
}

const request = (botId: string, title: string) => ({
  botId,
  workspaceId: 'ws-1',
  args: { titles: [title], preset: 'verify', prompt: `look at ${title}`, checkout: { sha: SHA, fetch_ref: 'pull/7/head' } },
  threadId: 'pr:github.com/o/r#7' as const,
  tainted: false,
  handoffId: 'h-dispatch',
});

describe('HeldFanouts', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-fanouts-'));
  });
  afterEach(() => {
    setHeldFanouts(null);
    vi.useRealTimers();
  });

  it('wakes the refused bot with its held request when a slot frees, through AgentSlots.kick()', async () => {
    const r = rig(dir);
    r.open.set(BOT_A, 1);
    expect(r.held.hold(request(BOT_A, 'verify #7'))).not.toBeNull();
    const slots = new AgentSlots({ cap: () => 3, runningBots: () => 0, liveWorkers: () => 0, onKick: releaseHeldFanouts });
    // Still full: a kick wakes nobody and the request stays held.
    slots.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.queue.list({ botId: BOT_A })).toEqual([]);
    expect(r.held.list(BOT_A)).toHaveLength(1);
    // The worker ends: its slot frees, and its ledger transition kicks the slots.
    r.open.set(BOT_A, 0);
    slots.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    const [wake] = r.queue.list({ botId: BOT_A });
    expect(wake).toMatchObject({
      state: 'queued',
      priority: 1,
      threadId: 'pr:github.com/o/r#7',
      reason: {
        kind: 'held_fanout',
        titles: ['verify #7'],
        args: { titles: ['verify #7'], preset: 'verify', prompt: 'look at verify #7', checkout: { sha: SHA, fetch_ref: 'pull/7/head' } },
        tainted: false,
        handoffId: 'h-dispatch',
      },
    });
    // Woken once: the request is no longer held, so a later kick adds nothing.
    expect(r.held.list()).toEqual([]);
    slots.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(1);
  });

  it('a request held at the wmux-wide live cap (the owner\'s fan-outs fill it) is woken only once a live slot frees', async () => {
    const r = rig(dir);
    let live = 8;
    r.ports.openWorkers = (botId) => ({ bot: r.open.get(botId) ?? 0, factory: 0, live });
    r.ports.liveLimit = () => 8;
    expect(r.held.hold(request(BOT_A, 'verify #7'))).not.toBeNull();
    // The bot's own and the factory's slots are free; wmux's are not.
    expect(await r.held.releaseNow()).toEqual([]);
    expect(r.queue.list({ botId: BOT_A })).toEqual([]);
    // One of the owner's fan-outs ends.
    live = 7;
    expect((await r.held.releaseNow()).map((h) => h.titles)).toEqual([['verify #7']]);
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(1);
  });

  it('the owner\'s own task ending, or its workspace closing, wakes a bot held at the wmux-wide live cap (no bot record moves)', async () => {
    const r = rig(dir);
    // Seven of the owner's tasks and one bot worker fill wmux's 8.
    const ownerLive = new Set(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']);
    r.ports.openWorkers = () => ({ bot: 0, factory: 1, live: ownerLive.size + 1 });
    r.ports.liveLimit = () => 8;
    const transitions = new Set<() => void>();
    const snapshots = new Set<() => void>();
    let workspaces = ['ws-o1', 'ws-o2'];
    const off = installHeldFanoutReleases({
      onTransition: (fn) => { transitions.add(fn); return () => transitions.delete(fn); },
      onWorkspaces: (fn) => { snapshots.add(fn); return () => snapshots.delete(fn); },
      openWorkspaces: () => workspaces,
    });
    expect(r.held.hold(request(BOT_A, 'verify #7'))).not.toBeNull();
    // A transition while wmux is still full wakes nobody.
    for (const fn of transitions) fn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.queue.list({ botId: BOT_A })).toEqual([]);
    // The owner's task o1 ends and its agent is gone: its row's transition
    // checks again, well before the 60-second recheck.
    ownerLive.delete('o1');
    for (const fn of transitions) fn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(1);
    expect(r.held.list()).toEqual([]);

    // Held again; this time the owner closes a task workspace (no row moves).
    r.ports.openWorkers = () => ({ bot: 0, factory: 1, live: 8 });
    r.held.hold(request(BOT_A, 'verify #8'));
    // A tree push that changes no open workspace (a focus) checks nothing.
    for (const fn of snapshots) fn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.held.list()).toHaveLength(1);
    r.ports.openWorkers = () => ({ bot: 0, factory: 1, live: 7 });
    workspaces = ['ws-o2'];
    for (const fn of snapshots) fn();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.held.list()).toEqual([]);
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(2);
    off();
    expect(transitions.size + snapshots.size).toBe(0);
  });

  it('one free live slot wakes one held request, not two', async () => {
    const r = rig(dir);
    r.ports.budget = () => ({ maxConcurrentWorkers: 2 });
    r.ports.openWorkers = () => ({ bot: 0, factory: 0, live: 7 });
    r.ports.liveLimit = () => 8;
    r.held.hold(request(BOT_A, 'verify #7'));
    r.held.hold(request(BOT_B, 'verify #8'));
    expect((await r.held.releaseNow()).map((h) => h.botId)).toEqual([BOT_A]);
    expect(r.held.list().map((h) => h.botId)).toEqual([BOT_B]);
  });

  it('a holder record that changes (a worker reclaimed or stopped) releases too', async () => {
    const r = rig(dir);
    r.open.set(BOT_A, 1);
    r.held.hold(request(BOT_A, 'x'));
    r.open.set(BOT_A, 0);
    holderInputsChanged();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.queue.list({ botId: BOT_A }).map((w) => w.reason.kind)).toEqual(['held_fanout']);
  });

  it('shares the factory\'s free slots oldest request first', async () => {
    const r = rig(dir);
    r.ports.factoryLimit = () => 1;
    r.open.set(BOT_B, 1);
    r.held.hold(request(BOT_A, 'first'));
    vi.advanceTimersByTime(10);
    r.held.hold(request(BOT_B, 'second'));
    r.open.set(BOT_B, 0);
    await r.held.releaseNow();
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(1);
    expect(r.queue.list({ botId: BOT_B })).toEqual([]);
    expect(r.held.list().map((h) => h.titles[0])).toEqual(['second']);
  });

  it('keeps a few requests per bot, never pushing a held one out, and they survive a restart', async () => {
    const r = rig(dir);
    r.open.set(BOT_A, 1);
    const kept = Array.from({ length: HELD_PER_BOT_MAX + 2 }, (_, i) => r.held.hold(request(BOT_A, `t${i}`)) !== null);
    expect(kept).toEqual([true, true, true, false, false]);
    expect(r.held.list(BOT_A).map((h) => h.titles[0])).toEqual(['t0', 't1', 't2']);
    // A retry of a held request is held once, as the latest.
    expect(r.held.hold(request(BOT_A, 't0'))).not.toBeNull();
    expect(r.held.list(BOT_A).map((h) => h.titles[0])).toEqual(['t1', 't2', 't0']);
    await r.held.flush();
    const again = HeldFanouts.at(dir, r.ports);
    again.load();
    expect(again.list(BOT_A).map((h) => h.titles[0])).toEqual(['t1', 't2', 't0']);
    expect(again.list(BOT_A)[0].args?.checkout).toEqual({ sha: SHA, fetch_ref: 'pull/7/head' });
    again.dispose();
  });

  it('keeps a request whose wake could not be queued, for the next free slot', async () => {
    const r = rig(dir);
    let refuse = true;
    r.ports.wakes = () => ({ enqueue: (input) => (refuse ? null : r.queue.enqueue(input)) });
    r.held.hold(request(BOT_A, 'x'));
    expect(await r.held.releaseNow()).toEqual([]);
    expect(r.held.list(BOT_A)).toHaveLength(1);
    refuse = false;
    expect(await r.held.releaseNow()).toHaveLength(1);
    expect(r.held.list()).toEqual([]);
  });

  it('the same arguments from another handoff are another request; one the bot started after all is no longer held', () => {
    const r = rig(dir);
    r.held.hold(request(BOT_A, 'x'));
    r.held.hold({ ...request(BOT_A, 'x'), handoffId: 'h-other' });
    expect(r.held.list(BOT_A).map((h) => h.handoffId)).toEqual(['h-dispatch', 'h-other']);
    r.held.hold(request(BOT_B, 'y'));
    // Started for its own handoff: the other handoff's request stays held.
    r.held.started(BOT_A, request(BOT_A, 'x').args, { threadId: 'pr:github.com/o/r#7', handoffId: 'h-dispatch' });
    expect(r.held.list().map((h) => [h.botId, h.handoffId])).toEqual([[BOT_A, 'h-other'], [BOT_B, 'h-dispatch']]);
  });

  it('a retry the bot started retires the wake already queued for the same request, and only that one', async () => {
    const r = rig(dir);
    setWakeQueue(r.queue);
    try {
      r.held.hold(request(BOT_A, 'x'));
      r.held.hold({ ...request(BOT_A, 'x'), handoffId: 'h-other' });
      await r.held.releaseNow();
      const wakes = r.queue.list({ botId: BOT_A });
      expect(wakes).toHaveLength(1);
      const context = { threadId: 'pr:github.com/o/r#7' as const, handoffId: 'h-dispatch' };
      expect(heldWakeIsFor(wakes[0], request(BOT_A, 'x').args, context)).toBe(true);
      expect(heldWakeIsFor(wakes[0], request(BOT_A, 'x').args, { ...context, handoffId: 'h-other' })).toBe(false);
      expect(heldWakeIsFor(wakes[0], request(BOT_A, 'y').args, context)).toBe(false);
      expect(dropQueuedHeldFanoutWakes(BOT_A, (w) => heldWakeIsFor(w, request(BOT_A, 'x').args, context))).toBe(1);
      expect(r.queue.get(wakes[0].id)?.state).toBe('dropped');
    } finally {
      setWakeQueue(null);
    }
  });

  it('a hold made outside a handoff is retired, with its queued wake, by the same request started from a handoff', async () => {
    // A bot retried a held fan-out from an answer's turn before its
    // held_fanout turn ran: the hold had no handoff, the retry carried the
    // answer's. The hold and its wake must not survive the launch.
    const r = rig(dir);
    setWakeQueue(r.queue);
    try {
      const outside = { ...request(BOT_A, 'x'), handoffId: undefined };
      const context = { threadId: 'pr:github.com/o/r#7' as const, handoffId: 'h-answer' };
      // Still held: the launch retires it.
      r.held.hold(outside);
      r.held.started(BOT_A, outside.args, context);
      expect(r.held.list(BOT_A)).toEqual([]);
      // Its wake already queued (a slot freed first): the launch drops it.
      r.held.hold(outside);
      await r.held.releaseNow();
      const wakes = r.queue.list({ botId: BOT_A });
      expect(wakes).toHaveLength(1);
      expect(wakes[0].reason).not.toHaveProperty('handoffId');
      expect(dropQueuedHeldFanoutWakes(BOT_A, (w) => heldWakeIsFor(w, outside.args, context))).toBe(1);
      expect(r.queue.get(wakes[0].id)?.state).toBe('dropped');
      // Another thread is another request.
      expect(heldWakeIsFor(wakes[0], outside.args, { ...context, threadId: 'pr:github.com/o/r#8' })).toBe(false);
    } finally {
      setWakeQueue(null);
    }
  });

  it('a request too long to keep is still matched when the bot starts it after all', () => {
    const r = rig(dir);
    const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const long = { titles, task_prompts: titles.map((t) => t.repeat(4_000)) };
    const h = r.held.hold({ ...request(BOT_A, 'a'), args: long });
    expect(h?.args).toBeUndefined();
    expect(h?.titles).toEqual(titles);
    r.held.started(BOT_A, long, { threadId: 'pr:github.com/o/r#7', handoffId: 'h-dispatch' });
    expect(r.held.list()).toEqual([]);
  });

  it('a hold leaves only once its wake is written: a failed write keeps it, and the retry reuses the same wake', async () => {
    const r = rig(dir);
    let fail = true;
    r.ports.wakes = () => ({ enqueue: (input) => r.queue.enqueue(input), flush: () => (fail ? Promise.reject(new Error('disk full')) : r.queue.flush()) });
    r.ports.log = () => undefined;
    r.held.hold(request(BOT_A, 'x'));
    expect(await r.held.releaseNow()).toEqual([]);
    expect(r.held.list(BOT_A)).toHaveLength(1);
    fail = false;
    expect(await r.held.releaseNow()).toHaveLength(1);
    expect(r.held.list()).toEqual([]);
    expect(r.queue.list({ botId: BOT_A })).toHaveLength(1);
  });

  it('a stored secret in a title is redacted in what is kept', () => {
    setRedactedSecrets([{ name: 'NPM_TOKEN', value: 'npm_s3cretValue1234567890' }]);
    try {
      const r = rig(dir);
      const h = r.held.hold({ ...request(BOT_A, 'x'), args: { titles: ['use npm_s3cretValue1234567890'] } });
      expect(JSON.stringify(h)).not.toContain('npm_s3cretValue1234567890');
    } finally {
      __resetRedactedSecretsForTesting();
    }
  });

  it('drops a request whose bot is gone or that could never fit its slots', async () => {
    const r = rig(dir);
    r.held.hold({ ...request(BOT_A, 'a'), args: { titles: ['a', 'b'] } });
    r.ports.budget = (botId) => (botId === BOT_A ? { maxConcurrentWorkers: 1 } : null);
    r.held.hold(request(BOT_B, 'gone'));
    expect(await r.held.releaseNow()).toEqual([]);
    expect(r.held.list()).toEqual([]);
    expect(r.queue.list({})).toEqual([]);
  });
});
