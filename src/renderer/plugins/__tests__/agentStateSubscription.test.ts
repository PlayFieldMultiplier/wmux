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
