import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CLAUDE_PROBE_TIMEOUT_MS, clearClaudeProbeCache, probeClaudeExecutable } from '../claudeProbe';
import { resolveClaudeLaunch } from '../../claude/resolveClaudeLaunch';

describe('probeClaudeExecutable', () => {
  beforeEach(() => clearClaudeProbeCache());

  it('returns the first line of --version on exit 0', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' }));
    await expect(probeClaudeExecutable('/bin/claude', { run, mtimeMs: () => null })).resolves.toEqual({
      ok: true,
      version: '2.1.0 (Claude Code)',
    });
    expect(run).toHaveBeenCalledWith('/bin/claude', ['--version'], { timeoutMs: CLAUDE_PROBE_TIMEOUT_MS });
  });

  it('a non-zero exit, timeout, or empty output is not ok', async () => {
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }), mtimeMs: () => null }))
      .resolves.toMatchObject({ ok: false });
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: null, stdout: '', stderr: 'killed' }), mtimeMs: () => null }))
      .resolves.toMatchObject({ ok: false, detail: expect.stringContaining('timed out') });
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: 0, stdout: '  \n', stderr: '' }), mtimeMs: () => null }))
      .resolves.toMatchObject({ ok: false });
  });

  it('an empty path never spawns', async () => {
    const run = vi.fn();
    await expect(probeClaudeExecutable('', { run })).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('launches a Windows cli.js under node (shared resolveClaudeLaunch)', async () => {
    const cli = 'C:\\Users\\a\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const run = vi.fn(async () => ({ code: 0, stdout: '2.0.0\n', stderr: '' }));
    await expect(
      probeClaudeExecutable(cli, {
        run,
        mtimeMs: () => null,
        launchOpts: { platform: 'win32', nodeExecutable: node },
      }),
    ).resolves.toEqual({ ok: true, version: '2.0.0' });
    const expected = resolveClaudeLaunch(cli, { platform: 'win32', nodeExecutable: node, args: ['--version'] });
    expect(run).toHaveBeenCalledWith(expected.command, expected.args, { timeoutMs: CLAUDE_PROBE_TIMEOUT_MS });
  });

  it('launches a Windows .cmd through cmd.exe (shared resolveClaudeLaunch)', async () => {
    const shim = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd';
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const run = vi.fn(async () => ({ code: 0, stdout: '2.0.1\n', stderr: '' }));
    await expect(
      probeClaudeExecutable(shim, {
        run,
        mtimeMs: () => null,
        launchOpts: { platform: 'win32', cmdExecutable: cmd },
      }),
    ).resolves.toEqual({ ok: true, version: '2.0.1' });
    const expected = resolveClaudeLaunch(shim, { platform: 'win32', cmdExecutable: cmd, args: ['--version'] });
    expect(run).toHaveBeenCalledWith(expected.command, expected.args, {
      timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
      windowsVerbatimArguments: true,
    });
  });

  it('caches a successful probe by path + mtime and skips re-spawn', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '1.0.0\n', stderr: '' }));
    const opts = { run, mtimeMs: () => 42 };
    await expect(probeClaudeExecutable('/bin/claude', opts)).resolves.toEqual({ ok: true, version: '1.0.0' });
    await expect(probeClaudeExecutable('/bin/claude', opts)).resolves.toEqual({ ok: true, version: '1.0.0' });
    expect(run).toHaveBeenCalledTimes(1);
    // mtime change → re-probe
    await expect(probeClaudeExecutable('/bin/claude', { run, mtimeMs: () => 99 })).resolves.toEqual({ ok: true, version: '1.0.0' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures; redacts secrets in detail', async () => {
    const run = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'auth failed token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    }));
    const first = await probeClaudeExecutable('/bin/claude', { run, mtimeMs: () => 1 });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.detail).not.toMatch(/sk-ant/);
      expect(first.detail).toMatch(/\[redacted\]/);
    }
    await probeClaudeExecutable('/bin/claude', { run, mtimeMs: () => 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
