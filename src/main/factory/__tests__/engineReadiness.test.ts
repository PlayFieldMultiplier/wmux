// The default engine's readiness (no model turn) and the Claude sign-in tab.

import { describe, expect, it, vi } from 'vitest';
import { claudeLoginLine, engineReadiness, startEngineLogin, type EngineLoginDeps } from '../engineReadiness';

describe('engineReadiness', () => {
  it('no claude executable: not installed, and the credential is never read', async () => {
    const credential = vi.fn(async () => ({ ok: true as const }));
    const r = await engineReadiness({ claudeExecutable: () => null, credential });
    expect(r).toMatchObject({ ready: false, reason: 'claude-not-installed' });
    expect(credential).not.toHaveBeenCalled();
  });

  it('installed and signed in: ready', async () => {
    expect(await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: true }) })).toEqual({ ready: true });
  });

  it('no stored sign-in: not logged in; an unreadable one: unknown with the sanitized detail', async () => {
    expect(await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: false, reason: 'not-found' }) }))
      .toMatchObject({ ready: false, reason: 'claude-not-logged-in' });
    const r = await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: false, reason: 'read-error', detail: 'Error EACCES' }) });
    expect(r).toMatchObject({ ready: false, reason: 'unknown' });
    expect(r.message).toContain('EACCES');
  });

  it('a throwing lookup reads as unknown, never as ready', async () => {
    const r = await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ ready: false, reason: 'unknown' });
  });
});

describe('startEngineLogin', () => {
  const deps = (over: Partial<EngineLoginDeps> = {}): EngineLoginDeps => ({
    openTab: vi.fn(async () => ({ ptyId: 'pty-1' })),
    typeLine: vi.fn(),
    windowsShell: () => 'pwsh.exe',
    platform: 'darwin',
    ...over,
  });

  it('opens a tab with the default shell and types the sign-in line into it', async () => {
    const d = deps();
    await startEngineLogin(d);
    expect(d.openTab).toHaveBeenCalledWith(undefined);
    expect(d.typeLine).toHaveBeenCalledWith('pty-1', 'env -u CLAUDE_CONFIG_DIR claude auth login');
  });

  it('on Windows the tab runs the native shell (a WSL default would sign in a Linux claude)', async () => {
    const d = deps({ platform: 'win32' });
    await startEngineLogin(d);
    expect(d.openTab).toHaveBeenCalledWith('pwsh.exe');
    expect(d.typeLine).toHaveBeenCalledWith('pty-1', '$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
  });

  it('the line clears CLAUDE_CONFIG_DIR in the syntax of the tab\'s shell', () => {
    expect(claudeLoginLine('darwin', undefined)).toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
    expect(claudeLoginLine('win32', 'powershell.exe')).toBe('$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Windows\\System32\\cmd.exe')).toBe('set "CLAUDE_CONFIG_DIR=" & claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
  });

  it('no tab: rejects with the command to run by hand, types nothing', async () => {
    const d = deps({ openTab: vi.fn(async () => ({ error: 'surface.new: no active workspace' })) });
    await expect(startEngineLogin(d)).rejects.toThrow('claude auth login');
    expect(d.typeLine).not.toHaveBeenCalled();
  });

  it('a second call while one is opening shares it (one tab)', async () => {
    let release!: (v: { ptyId: string }) => void;
    const d = deps({ openTab: vi.fn(() => new Promise<{ ptyId: string }>((r) => { release = r; })) });
    const a = startEngineLogin(d);
    const b = startEngineLogin(d);
    release({ ptyId: 'pty-2' });
    await Promise.all([a, b]);
    expect(d.openTab).toHaveBeenCalledTimes(1);
    expect(d.typeLine).toHaveBeenCalledTimes(1);
  });
});
