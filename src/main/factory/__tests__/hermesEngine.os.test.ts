import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HERMES_SETTINGS,
  clearHermesProbeCache,
  hermesEnv,
  hermesReadiness,
  hermesSettingsMismatches,
  type HermesProbeResult,
  type HermesRun,
} from '../hermesEngine';

// A fake `hermes` over an in-memory config: `config get --json`, `config set`
// (YAML-ish scalars and `[a, b]` lists), `config unset`, `--version`.
function fakeHermes(opts: { version?: string; config?: Record<string, unknown>; sticky?: Record<string, unknown> } = {}) {
  const config = new Map<string, unknown>(Object.entries(opts.config ?? {}));
  const calls: string[][] = [];
  const parse = (s: string): unknown => {
    if (s.startsWith('[')) return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    if (s === 'true' || s === 'false') return s === 'true';
    if (/^\d+$/.test(s)) return Number(s);
    return s;
  };
  const run: HermesRun = async (_exe, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: `Hermes Agent v${opts.version ?? '0.22.5'} (2026.10.1)\n`, stderr: '' };
    const key = args[args.length - 1];
    if (args[1] === 'get') {
      const v = opts.sticky && key in opts.sticky ? opts.sticky[key] : config.get(key);
      return v === undefined ? { code: 1, stdout: '', stderr: 'Config key not set' } : { code: 0, stdout: JSON.stringify(v), stderr: '' };
    }
    if (args[1] === 'set') config.set(args[2], parse(args[3]));
    if (args[1] === 'unset') config.delete(args[2]);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, config };
}

describe('hermesSettingsMismatches', () => {
  it('names a widened toolset and any MCP server, plugin or command allowlist as wrong', () => {
    const good = new Map<string, unknown>([
      ['platform_toolsets.acp', ['todo', 'web']],
      ['agent.disabled_toolsets', ['terminal', 'code_execution', 'file', 'browser', 'delegation', 'connections', 'skills', 'memory', 'vision', 'session_search']],
      ['updates.check', false],
      ['tools.tool_search.enabled', 'off'],
      ['approvals.mode', 'manual'],
      ['approvals.timeout', 300],
      ['gateway.unmanaged_idle_exit_seconds', 600],
      ['security.allow_private_urls', false],
    ]);
    expect(hermesSettingsMismatches(good)).toEqual([]);

    const bad = new Map(good);
    bad.set('platform_toolsets.acp', ['web', 'todo', 'terminal']);
    bad.set('mcp_servers', { fs: { command: 'npx' } });
    bad.set('plugins.enabled', ['x']);
    bad.set('command_allowlist', ['rm']);
    bad.set('security.allow_private_urls', true);
    expect(hermesSettingsMismatches(bad).sort()).toEqual(
      ['command_allowlist', 'mcp_servers', 'platform_toolsets.acp', 'plugins.enabled', 'security.allow_private_urls'].sort());
  });
});

describe('hermesEnv', () => {
  it('passes only the allowlist, points HERMES_HOME at R and adds the installer folder to PATH', () => {
    const env = hermesEnv('/data/factory/hermes', {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      ANTHROPIC_API_KEY: 'sk-x',
      OPENROUTER_API_KEY: 'or-x',
      WMUX_PANE_ID: 'p1',
      WMUX_AUTH_TOKEN: 't',
      HERMES_HOME: '/home/u/.hermes',
    }, 'darwin', '/home/u');
    expect(env).toEqual({
      PATH: '/usr/bin:/home/u/.local/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      HERMES_HOME: '/data/factory/hermes',
      PYTHONIOENCODING: 'utf-8',
    });
  });
});

describe('hermesReadiness', () => {
  let root: string;
  const okProbe = async (): Promise<HermesProbeResult> => ({ ok: true });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ready-'));
    clearHermesProbeCache();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deps = (run: HermesRun, probe = okProbe) => ({
    root, run, probe, resolveExe: () => '/bin/hermes', env: (r: string) => ({ HERMES_HOME: r }),
  });

  it('writes wmux\'s settings, unsets MCP servers and the command allowlist, then is ready', async () => {
    const h = fakeHermes({ config: { model: { default: 'm1' }, mcp_servers: { fs: {} }, command_allowlist: ['ls'] } });
    expect(await hermesReadiness(deps(h.run))).toEqual({ ready: true, version: '0.22.5' });
    expect(h.config.has('mcp_servers')).toBe(false);
    expect(h.config.has('command_allowlist')).toBe(false);
    expect(hermesSettingsMismatches(new Map(HERMES_SETTINGS.map((s) => [s.key, h.config.get(s.key)])))).toEqual([]);
  });

  it('is not ready when a setting does not read back, the version is outside the range, or MCP is missing', async () => {
    const sticky = fakeHermes({ config: { model: 'm1' }, sticky: { 'platform_toolsets.acp': ['web', 'todo', 'terminal'] } });
    expect(await hermesReadiness(deps(sticky.run))).toMatchObject({ ready: false, reason: 'config-mismatch' });

    expect(await hermesReadiness(deps(fakeHermes({ version: '0.19.0' }).run))).toMatchObject({ ready: false, reason: 'outdated', version: '0.19.0' });
    expect(await hermesReadiness(deps(fakeHermes({ version: '0.23.0' }).run))).toMatchObject({ ready: false, reason: 'unsupported' });
    expect(await hermesReadiness(deps(fakeHermes().run))).toMatchObject({ ready: false, reason: 'not-set-up' });

    const missing = async (): Promise<HermesProbeResult> => ({ ok: false, reason: 'mcp-missing', detail: 'no mcp' });
    expect(await hermesReadiness(deps(fakeHermes({ config: { model: 'm1' } }).run, missing))).toMatchObject({ ready: false, reason: 'mcp-missing' });
  });
});
