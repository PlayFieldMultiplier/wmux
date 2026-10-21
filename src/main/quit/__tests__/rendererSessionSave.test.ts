import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_SAVE_TIMEOUT_MS, requestRendererSessionSave } from '../rendererSessionSave';

afterEach(() => { vi.useRealTimers(); });

describe('requestRendererSessionSave', () => {
  it('dispatches beforeunload in the renderer and resolves when it answers', async () => {
    const executeJavaScript = vi.fn(async (_code: string) => undefined);
    await requestRendererSessionSave({ executeJavaScript });
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(executeJavaScript.mock.calls[0][0]).toContain("new Event('beforeunload')");
  });

  it('rejects once the bound passes when the renderer never answers', async () => {
    vi.useFakeTimers();
    const executeJavaScript = vi.fn(() => new Promise<unknown>(() => { /* never answers */ }));
    const save = requestRendererSessionSave({ executeJavaScript });
    const outcome = save.then(() => 'resolved', (err: Error) => err.message);

    await vi.advanceTimersByTimeAsync(RENDERER_SAVE_TIMEOUT_MS);

    expect(await outcome).toBe('renderer session-save timed out');
  });

  it('leaves no timer behind after an answered save', async () => {
    vi.useFakeTimers();
    await requestRendererSessionSave({ executeJavaScript: async () => undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});
