// The browser shim's writeLaunch goes to the daemon as a launch line (which
// applies the folder-trust policy), never as plain typed input.
import { describe, expect, it, vi } from 'vitest';
import { lateBoundPty } from '../webElectronApi';

describe('lateBoundPty writeLaunch', () => {
  it('forwards the line, its Enter and its origin to the bridge\'s launch path', async () => {
    const bridge = { write: vi.fn(async () => undefined), writeLaunch: vi.fn(async () => undefined) };
    const pty = lateBoundPty(() => bridge);
    await pty.writeLaunch('pty-1', 'claude --resume x', true);
    await pty.writeLaunch('pty-1', 'claude', false, 'human');
    expect(bridge.writeLaunch.mock.calls).toEqual([['pty-1', 'claude --resume x\r', undefined], ['pty-1', 'claude', 'human']]);
    expect(bridge.write).not.toHaveBeenCalled();
  });
});
