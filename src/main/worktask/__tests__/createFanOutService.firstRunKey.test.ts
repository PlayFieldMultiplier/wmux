// The first-run watch's dismiss key goes through the daemon, and not into a
// pane the daemon sees on a folder-trust prompt.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));

import { sendFirstRunKey } from '../createFanOutService';

function daemon(state: 'trust' | 'clear' | 'unknown') {
  return { isConnected: true, folderTrustState: vi.fn(async () => ({ state })), writeToSession: vi.fn(() => true) };
}

describe('sendFirstRunKey', () => {
  it('writes nothing at a folder-trust prompt and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dc = daemon('trust');
    await expect(sendFirstRunKey(dc, 'pty-1', '\x1b')).rejects.toThrow(/folder-trust prompt/);
    expect(dc.writeToSession).not.toHaveBeenCalled();
  });

  it('presses the key at any other screen, an unreadable one included (Escape stops only at the prompt itself)', async () => {
    for (const state of ['clear', 'unknown'] as const) {
      const dc = daemon(state);
      await sendFirstRunKey(dc, 'pty-1', '\x1b');
      expect(dc.writeToSession).toHaveBeenCalledWith('pty-1', '\x1b');
    }
  });
});
