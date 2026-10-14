// The default engine's readiness (no model turn) and the Claude sign-in tab.

import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_LOGIN_LINE, engineReadiness, startEngineLogin, type EngineLoginDeps } from '../engineReadiness';

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
    expect(d.typeLine).toHaveBeenCalledWith('pty-1', CLAUDE_LOGIN_LINE);
  });

  it('on Windows the tab runs the native shell (a WSL default would sign in a Linux claude)', async () => {
    const d = deps({ platform: 'win32' });
    await startEngineLogin(d);
    expect(d.openTab).toHaveBeenCalledWith('pwsh.exe');
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
