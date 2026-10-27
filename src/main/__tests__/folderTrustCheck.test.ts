// Main's launch writers ask the daemon once before they type: a folder-trust
// prompt on screen always stops them, a screen that cannot rule one out stops
// only an automated line, and no verdict to have types as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderTrustLaunchRefusal } from '../folderTrustCheck';
import { FOLDER_TRUST_LAUNCH_REFUSAL } from '../../shared/folderTrustWording';
import type { DaemonClient } from '../DaemonClient';

type Answer = Awaited<ReturnType<DaemonClient['folderTrustState']>>;
const daemon = (answer: Answer) => ({ folderTrustState: vi.fn(async () => answer) });

afterEach(() => vi.restoreAllMocks());

describe('folderTrustLaunchRefusal', () => {
  it('refuses at a folder-trust prompt whoever types, with one log line naming the writer and the verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dc = daemon({ state: 'trust' });
    expect(await folderTrustLaunchRefusal(dc, 'pty-1', 'launch line', { refuseUnknown: false })).toBe(FOLDER_TRUST_LAUNCH_REFUSAL);
    expect(await folderTrustLaunchRefusal(dc, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBe(FOLDER_TRUST_LAUNCH_REFUSAL);
    expect(dc.folderTrustState).toHaveBeenCalledWith('pty-1', 400);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[folder-trust] refused launch line on pane pty-1: folder-trust trust',
      '[folder-trust] refused auto-resume line on pane pty-1: folder-trust trust',
    ]);
  });

  it('refuses an unreadable screen only for an automated line, and types as before with no verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unknown = daemon({ state: 'unknown' });
    expect(await folderTrustLaunchRefusal(unknown, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toMatch(/folder-trust prompt cannot be ruled out/);
    expect(await folderTrustLaunchRefusal(unknown, 'pty-1', 'launch line', { refuseUnknown: false })).toBeNull();
    expect(await folderTrustLaunchRefusal(daemon({ state: 'clear' }), 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(await folderTrustLaunchRefusal(daemon({ unavailable: 'timeout' }), 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(await folderTrustLaunchRefusal(null, 'pty-1', 'auto-resume line', { refuseUnknown: true })).toBeNull();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[folder-trust] refused auto-resume line on pane pty-1: folder-trust unknown',
      '[folder-trust] check unavailable on pane pty-1: timeout',
    ]);
  });
});
