import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_PROBE_TIMEOUT_MS, probeClaudeExecutable } from '../claudeProbe';

describe('probeClaudeExecutable', () => {
  it('returns the first line of --version on exit 0', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' }));
    await expect(probeClaudeExecutable('/bin/claude', { run })).resolves.toEqual({ ok: true, version: '2.1.0 (Claude Code)' });
    expect(run).toHaveBeenCalledWith('/bin/claude', ['--version'], { timeoutMs: CLAUDE_PROBE_TIMEOUT_MS });
  });

  it('a non-zero exit, timeout, or empty output is not ok', async () => {
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }) }))
      .resolves.toMatchObject({ ok: false });
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: null, stdout: '', stderr: 'killed' }) }))
      .resolves.toMatchObject({ ok: false, detail: expect.stringContaining('timed out') });
    await expect(probeClaudeExecutable('/bin/claude', { run: async () => ({ code: 0, stdout: '  \n', stderr: '' }) }))
      .resolves.toMatchObject({ ok: false });
  });

  it('an empty path never spawns', async () => {
    const run = vi.fn();
    await expect(probeClaudeExecutable('', { run })).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });
});
