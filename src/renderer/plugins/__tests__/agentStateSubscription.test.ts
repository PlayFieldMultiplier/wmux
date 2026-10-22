import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeAgentState } from '../agentStateSubscription';
const snapshot = { workspaceId: 'w1', panes: [], truncated: false };
afterEach(() => vi.useRealTimers());
describe('agent state subscription lifetime', () => {
  it('emits reset then first snapshot, suppresses duplicates and tears down', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const read = vi.fn(async () => ({ ok: true, result: snapshot }));
    const stop = subscribeAgentState({ workspaceId: 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(post).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('never overlaps a read or posts a late result after scope changes', async () => {
    vi.useFakeTimers();
    let resolve!: (v: unknown) => void;
    let current = true;
    const post = vi.fn();
    const read = vi.fn(() => new Promise((r) => { resolve = r; }));
    const stop = subscribeAgentState({ workspaceId: 'w1', post, read, isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    current = false;
    resolve({ ok: true, result: snapshot });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    stop();
  });
  it('clears stale state during startup and recovers even to the same snapshot', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const read = vi.fn().mockResolvedValueOnce({ ok: true, result: snapshot })
      .mockResolvedValueOnce({ ok: false, retryable: true })
      .mockResolvedValue({ ok: true, result: snapshot });
    const stop = subscribeAgentState({ workspaceId: 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready', 'reset', 'ready']);
    expect(post.mock.calls[2][0].snapshot).toBeUndefined();
    stop();
  });
  it('cancels startup retries on teardown and stops when retry becomes a refusal', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({ ok: false, retryable: true });
    const stop = subscribeAgentState({ workspaceId: 'w1', post: vi.fn(), read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockReset().mockResolvedValueOnce({ ok: false, retryable: true }).mockResolvedValue({ ok: false });
    const post = vi.fn();
    const stopNext = subscribeAgentState({ workspaceId: 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.at(-1)?.[0].status).toBe('unavailable');
    stopNext();
  });
  it('clears on refusal and stops rather than retaining stale state', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const read = vi.fn().mockResolvedValueOnce({ ok: true, result: snapshot }).mockResolvedValue({ ok: false });
    const stop = subscribeAgentState({ workspaceId: 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready', 'unavailable']);
    expect(post.mock.calls[2][0].snapshot).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('agent state subscription for every workspace', () => {
  const all = { truncated: false, workspaces: [
    { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [] },
    { workspaceId: 'w2', name: 'beta', truncated: false, panes: [] },
  ] };
  it('posts allWorkspaces, never snapshot, and follows the bound workspace without restarting', async () => {
    vi.useFakeTimers();
    let bound = 'w1';
    const post = vi.fn();
    const read = vi.fn(async () => ({ ok: true, result: all }));
    const stop = subscribeAgentState({ scope: 'all', workspaceId: () => bound, post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready']);
    expect(post.mock.calls[1][0]).toMatchObject({ workspaceId: 'w1', allWorkspaces: all });
    expect(post.mock.calls[1][0]).not.toHaveProperty('snapshot');
    await vi.advanceTimersByTimeAsync(2000);
    expect(post).toHaveBeenCalledTimes(2);
    // A switch alone is a new revision of the same stream, not a reset.
    bound = 'w2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][0]).toMatchObject({ status: 'ready', workspaceId: 'w2', epoch: post.mock.calls[1][0].epoch });
    stop();
  });
  it('keeps running while no workspace is bound, and reads once one is', async () => {
    vi.useFakeTimers();
    let bound: string | undefined;
    const post = vi.fn();
    const read = vi.fn(async () => ({ ok: true, result: all }));
    const stop = subscribeAgentState({ scope: 'all', workspaceId: () => bound, post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(3000);
    // An unbound read would be refused by main, so none is made.
    expect(read).not.toHaveBeenCalled();
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset']);
    bound = 'w1';
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready']);
    expect(post.mock.calls[1][0]).toMatchObject({ workspaceId: 'w1', allWorkspaces: all });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('ends with unavailable when a read is refused (a revoked grant)', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const read = vi.fn().mockResolvedValueOnce({ ok: true, result: all }).mockResolvedValue({ ok: false });
    const stop = subscribeAgentState({ scope: 'all', workspaceId: () => 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'ready', 'unavailable']);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
  it('rejects a single-workspace answer on the all-workspaces stream', async () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const read = vi.fn(async () => ({ ok: true, result: snapshot }));
    const stop = subscribeAgentState({ scope: 'all', workspaceId: () => 'w1', post, read, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(post.mock.calls.map(([e]) => e.status)).toEqual(['reset', 'unavailable']);
    stop();
  });
});
