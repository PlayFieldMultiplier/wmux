// The own-mode Hermes host: every start condition is checked right before a
// spawn, a refusal spawns nothing, and the owner's gateway is never stopped.
// Fake Hermes homes and a fake runner; macOS and Linux only (v1), so on
// Windows the same home is refused as unsupported before anything runs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpBrainAdapter } from '../../deck/AcpBrainAdapter';
import type { BrainEvent } from '../../deck/BrainAdapter';
import type { HermesRun } from '../hermesEngine';
import type { MyHermesReadinessDeps } from '../myHermes';
import { OwnHermesHost, gatewayModeFlags, ownHermesToolAllowed } from '../myHermesHost';

const WIN = process.platform === 'win32';
const BINDING = { workspaceId: 'ws-1', botId: 'bot-0000000a', role: 'lead' as const };

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-ownhost-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

interface Answers { version?: string; config?: Record<string, unknown> }

/** ~/.hermes with its install and the installer's launcher; a fake runner. */
function rig(answers: Answers = {}) {
  const root = path.join(home, '.hermes');
  const venvExe = path.join(root, 'hermes-agent', 'venv', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(venvExe), { recursive: true });
  fs.writeFileSync(venvExe, '#!/usr/bin/env python3\n', { mode: 0o755 });
  const exe = path.join(home, '.local', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/usr/bin/env bash\nexec "${venvExe}" "$@"\n`, { mode: 0o755 });
  const calls: string[][] = [];
  const config = answers.config ?? { model: { default: 'x/y' }, 'approvals.mode': 'manual' };
  const run: HermesRun = async (_exe, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: `Hermes Agent v${answers.version ?? '0.22.5'}\n`, stderr: '' };
    if (args[0] === 'acp') return { code: 0, stdout: 'Hermes ACP check OK\n', stderr: '' };
    const key = args[args.length - 1];
    if (key in config) return { code: 0, stdout: `${JSON.stringify(config[key])}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `Config key not set: ${key}` };
  };
  const alive = new Set<number>();
  const deps: MyHermesReadinessDeps = { home, platform: process.platform, resolveExe: () => exe, run, baseEnv: { PATH: '/usr/bin' }, pidAlive: (p) => alive.has(p) };
  const writeGateway = (pid: number, argv: string[], platforms: Record<string, unknown> = {}): void => {
    fs.writeFileSync(path.join(root, 'gateway_state.json'), JSON.stringify({ pid, argv, hermes_home: root, platforms }));
    alive.add(pid);
  };
  return { root, exe, calls, deps, alive, writeGateway };
}

function hostOf(r: ReturnType<typeof rig>, holder: (p: string, id: string) => { id: string; name: string } | null = () => null): OwnHermesHost {
  return new OwnHermesHost({ profile: 'default', readinessDeps: () => r.deps, holder, pidAlive: (p) => r.alive.has(p), log: () => undefined });
}

/** An adapter on the host's policy whose spawns are counted. */
function adapterOn(host: OwnHermesHost) {
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const adapter = new AcpBrainAdapter({
    spawnSpec: { command: 'hermes', args: ['acp'] },
    newSessionSettleMs: 0,
    mcpBundlePath: '/app/mcp/index.js',
    spawnFn: (cmd, args) => {
      spawns.push({ cmd, args });
      throw new Error('a refused own-mode bot must not spawn');
    },
    bot: { binding: BINDING, cwd: home },
    hermes: host.policyFor(BINDING),
  });
  return { adapter, spawns };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe.runIf(WIN)('OwnHermesHost on Windows', () => {
  it('refuses before anything runs', async () => {
    const r = rig();
    expect(await hostOf(r).prepareSpawn(BINDING.botId)).toMatchObject({ ok: false });
    expect(r.calls).toEqual([]);
  });
});

describe.skipIf(WIN)('OwnHermesHost.prepareSpawn', () => {
  it('a ready profile spawns `hermes -p <profile> acp` with HERMES_HOME on the profile', async () => {
    const r = rig();
    const p = await hostOf(r).prepareSpawn(BINDING.botId);
    expect(p).toMatchObject({ ok: true, exe: r.exe, args: ['-p', 'default', 'acp'] });
    if (p.ok) expect(p.env.HERMES_HOME).toBe(r.root);
  });

  it('a messenger in the profile on a cold start: refused, and the adapter spawns nothing', async () => {
    const r = rig();
    fs.writeFileSync(path.join(r.root, '.env'), 'TELEGRAM_BOT_TOKEN=secret-value\n');
    const { adapter, spawns } = adapterOn(hostOf(r));
    adapter.start({});
    const events = await collect(adapter.send('hi'));
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('telegram') }]);
    expect(JSON.stringify(events)).not.toContain('secret-value');
    expect(spawns).toEqual([]);
    adapter.dispose();
  });

  it('an old or foreign Hermes is refused with no spawn', async () => {
    const old = rig({ version: '0.19.0' });
    const a = adapterOn(hostOf(old));
    expect((await collect(a.adapter.send('hi')))[0]).toMatchObject({ type: 'error', message: expect.stringContaining('hermes update') });
    expect(a.spawns).toEqual([]);
    a.adapter.dispose();
    const r = rig();
    const stray = path.join(home, 'stray-hermes');
    fs.writeFileSync(stray, '#!/bin/sh\nexec /opt/other/hermes "$@"\n', { mode: 0o755 });
    const b = adapterOn(new OwnHermesHost({ profile: 'default', readinessDeps: () => ({ ...r.deps, resolveExe: () => stray }), holder: () => null, log: () => undefined }));
    expect((await collect(b.adapter.send('hi')))[0]).toMatchObject({ type: 'error', message: expect.stringContaining('not the one installed') });
    expect(b.spawns).toEqual([]);
    b.adapter.dispose();
  });

  it('a running gateway started with --yolo, --safe-mode or ignore_user_config is not attached to', async () => {
    for (const argv of [['hermes', 'gateway', 'run', '--yolo'], ['hermes', 'gateway', 'run', '--safe-mode'], ['python', '-m', 'hermes_cli.main', 'gateway', 'run', '--ignore-user-config']]) {
      const r = rig();
      r.writeGateway(4242, argv);
      expect(await hostOf(r).prepareSpawn(BINDING.botId)).toMatchObject({ ok: false, message: expect.stringContaining(argv[argv.length - 1]) });
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home);
    }
    // The same flags in a dead gateway's state file do not refuse.
    const r = rig();
    r.writeGateway(4243, ['hermes', 'gateway', 'run', '--yolo']);
    r.alive.clear();
    expect(await hostOf(r).prepareSpawn(BINDING.botId)).toMatchObject({ ok: true });
  });

  it('a second bot on the profile (a copied bots.json) is refused in prepare', async () => {
    const r = rig();
    const host = hostOf(r, (profile, botId) => (profile === 'default' && botId !== 'bot-0000000b' ? { id: 'bot-0000000b', name: 'Bea' } : null));
    const { adapter, spawns } = adapterOn(host);
    expect((await collect(adapter.send('hi')))[0]).toMatchObject({ type: 'error', message: expect.stringContaining('Bea already uses this Hermes profile') });
    expect(spawns).toEqual([]);
    adapter.dispose();
  });

  it('never stops the owner\'s gateway: unsettled and shutdown run no Hermes command', async () => {
    const r = rig();
    r.writeGateway(4244, ['hermes', 'gateway', 'run']);
    const host = hostOf(r);
    const kill = vi.spyOn(process, 'kill');
    await host.policyFor(BINDING).unsettled();
    await host.shutdown();
    expect(r.calls).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
});

describe('own-mode helpers', () => {
  it('reads the gateway mode flags in any spelling', () => {
    expect(gatewayModeFlags(['hermes', 'gateway', 'run', '--quiet'])).toEqual([]);
    expect(gatewayModeFlags(['--yolo', '--safe_mode', '--ignore-user-config=1'])).toEqual(['--yolo', '--safe_mode', '--ignore-user-config=1']);
  });

  it('holds every tool of the owner\'s Hermes, but of wmux only room_post', () => {
    expect(ownHermesToolAllowed('terminal')).toBe(true);
    expect(ownHermesToolAllowed('mcp__editor_github_ab12__create_issue')).toBe(true);
    expect(ownHermesToolAllowed('mcp__editor_wmux_ab12__room_post')).toBe(true);
    expect(ownHermesToolAllowed('mcp__editor_wmux_ab12__room_read')).toBe(false);
    expect(ownHermesToolAllowed('mcp__editor_wmux_ab12__fanout_start')).toBe(false);
  });
});

