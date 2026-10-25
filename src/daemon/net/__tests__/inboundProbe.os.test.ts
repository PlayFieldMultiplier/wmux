import { describe, it, expect } from 'vitest';
import type os from 'node:os';
import { probeInbound, PROBE_TIMEOUT_MS, type ProbeExec, type ProbeTarget } from '../inboundProbe';
import type { FirewallRuleRecord } from '../firewallRecord';
import { firewallRuleIds, type RuleScope } from '../../../shared/netFirewallScripts';

const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe';
const SCOPE: RuleScope = { dataSuffix: '', user: 'DESK\\me', group: 'wmux' };
const on = { en: 1, inb: 1, loc: 1 };

const IFACES = {
  Tailscale: [{ address: '100.79.244.107', family: 'IPv4' }],
  'Wi-Fi': [{ address: '192.168.45.28', family: 'IPv4' }],
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.17.48.1', family: 'IPv4' }],
} as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function line(rules: object[] = [], addr: object[] = [{ ip: '100.79.244.107', cat: 1 }, { ip: '192.168.45.28', cat: 0 }, { ip: '172.17.48.1', cat: -1 }]): string {
  return `${JSON.stringify({ v: 1, prof: { Domain: on, Private: on, Public: on }, addr, rules, legacy: 0, tp: 0, tpName: null })}\r\n`;
}

const target = (over: Partial<ProbeTarget> = {}): ProbeTarget => ({
  listener: 'a2a',
  applicable: true,
  port: 45660,
  ips: ['100.79.244.107', '192.168.45.28', '172.17.48.1'],
  tailnet: false,
  inboundSeenAt: 42,
  ...over,
});

function run(
  exec: ProbeExec,
  over: { exe?: string; record?: FirewallRuleRecord | null; platform?: NodeJS.Platform; t?: Partial<ProbeTarget>; exists?: boolean; localDrive?: boolean; system32?: string | null } = {},
) {
  return probeInbound(target(over.t), {
    platform: over.platform ?? 'win32',
    exe: over.exe ?? EXE,
    scope: SCOPE,
    record: () => over.record ?? null,
    exec,
    ifaces: () => IFACES,
    exists: () => over.exists ?? true,
    onLocalFixedDrive: () => over.localDrive ?? true,
    system32: () => (over.system32 === undefined ? 'C:\\Windows\\System32' : over.system32),
    now: () => 7,
    log: () => undefined,
  });
}

describe('probeInbound on Windows', () => {
  it('runs absolute Windows PowerShell with -NoProfile -NonInteractive -Command and the 8 s deadline', async () => {
    const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
    await run(async (file, args, opts) => {
      calls.push({ file, args, timeout: opts.timeout });
      return line();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0].timeout).toBe(PROBE_TIMEOUT_MS);
    expect(PROBE_TIMEOUT_MS).toBe(8_000);
    expect(calls[0].args[3]).toContain("$o['legacy']=0");
  });

  it('only LanLink scans for the legacy rules', async () => {
    let script = '';
    await run(async (_f, args) => { script = args[3]; return line(); }, { t: { listener: 'lanlink', port: 45651 } });
    expect(script).toContain('-DisplayName $legacyNames');
  });

  it('a Tailscale Private + Wi-Fi Public listener with a prompt Allow: covered by prompt, exposed on Public, networks by name, vEthernet ignored', async () => {
    const s = await run(async () => line([{ act: 'Allow', prof: 'Private, Public', proto: 'TCP', hit: 1, anyPort: 1, ours: 0, tn: 0, legacy: 0, src: 'Local' }]));
    expect(s).toMatchObject({
      listener: 'a2a',
      platform: 'win32',
      applicable: true,
      port: 45660,
      verdict: 'covered-by-prompt',
      exposedPublic: true,
      publicBlocked: false,
      okNetworks: ['Tailscale'],
      publicNetworks: ['Wi-Fi'],
      exe: EXE,
      refusal: null,
      checkedAt: 7,
      inboundSeenAt: 42,
    });
    expect(s.ruleIds?.allow).toMatch(/^wmux-a2a-[0-9a-f]{8}-allow$/);
  });

  it('stale-after-update comes from this install\'s record of an older exe; another install\'s record is not an update', async () => {
    const id = firewallRuleIds('a2a', EXE, SCOPE).base;
    const record: FirewallRuleRecord = { listener: 'a2a', id, port: 45660, exe: EXE.replace('4.10.0', '4.9.0'), createdAt: 1 };
    expect((await run(async () => line(), { record })).verdict).toBe('stale-after-update');
    expect((await run(async () => line(), { record: { ...record, id: 'wmux-a2a-0badf00d', exe: 'D:\\portable\\wmux.exe' } })).verdict).toBe('not-covered');
  });

  it('a tailnet address needs our Allow to reach the tailnet range', async () => {
    const ours = { act: 'Allow', prof: 'Private', proto: 'TCP', hit: 1, anyPort: 0, ours: 1, legacy: 0, src: 'Local' };
    expect((await run(async () => line([{ ...ours, tn: 0 }]), { t: { tailnet: true } })).verdict).toBe('not-covered');
    expect((await run(async () => line([{ ...ours, tn: 1 }]), { t: { tailnet: true } })).verdict).toBe('covered');
  });

  it('a program on a network or SUBST drive is probed but refused the Fix', async () => {
    const s = await run(async () => line(), { localDrive: false });
    expect(s.verdict).toBe('not-covered');
    expect(s.refusal).toBe('not-local-drive');
  });

  it('no System32 from Windows: nothing is run, the answer is unknown', async () => {
    let ran = false;
    const s = await run(async () => { ran = true; return line(); }, { system32: null });
    expect(ran).toBe(false);
    expect(s.verdict).toBe('unknown');
  });

  it('a timeout, a failed spawn or an unreadable line is unknown, still applicable', async () => {
    for (const exec of [
      async () => { throw Object.assign(new Error('spawn timed out'), { killed: true }); },
      async () => 'garbage',
      async () => `${line()}${line()}`,
    ] as ProbeExec[]) {
      const s = await run(exec);
      expect(s.verdict).toBe('unknown');
      expect(s.applicable).toBe(true);
    }
  });

  it('a node.exe daemon is probed but refused the Fix', async () => {
    const s = await run(async () => line(), { exe: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(s.verdict).toBe('not-covered');
    expect(s.refusal).toBe('node-daemon');
  });

  it('a path the script cannot carry is never run', async () => {
    let ran = false;
    const s = await run(async () => { ran = true; return line(); }, { exe: 'C:\\Users\\$me\\wmux\\wmux.exe' });
    expect(ran).toBe(false);
    expect(s.verdict).toBe('unknown');
    expect(s.refusal).toBe('bad-path');
    // A wildcard: -Program would match other programs' rules, so nothing is read.
    const wild = await run(async () => { ran = true; return line(); }, { exe: 'C:\\apps\\x[1]\\wmux.exe' });
    expect(ran).toBe(false);
    expect(wild).toMatchObject({ verdict: 'unknown', refusal: 'bad-path' });
  });

  it('nothing to check while the listener is down: no process at all', async () => {
    let ran = false;
    const s = await run(async () => { ran = true; return line(); }, { t: { applicable: false, port: null } });
    expect(ran).toBe(false);
    expect(s.applicable).toBe(false);
  });
});

describe('probeInbound elsewhere', () => {
  it('macOS reads socketfilterfw four times (unverified on a Mac)', async () => {
    const files: string[][] = [];
    const s = await run(async (file, args) => {
      files.push([file, ...args]);
      if (args[0] === '--getglobalstate') return 'Firewall is enabled. (State = 1)';
      if (args[0] === '--getblockall') return 'Firewall has block all state set to disabled.';
      if (args[0] === '--getallowsigned') return 'Automatically allow built-in signed software ENABLED.\nAutomatically allow downloaded signed software ENABLED.';
      return 'The application /Applications/wmux.app/Contents/MacOS/wmux is blocked';
    }, { platform: 'darwin', exe: '/Applications/wmux.app/Contents/MacOS/wmux' });
    expect(files.map((f) => f[1])).toEqual(['--getglobalstate', '--getblockall', '--getappblocked', '--getallowsigned']);
    expect(s.verdict).toBe('not-covered');
    expect(s.ruleIds).toBeNull();
    expect(s.refusal).toBeNull();
  });

  it('macOS refuses the Fix for a node or development Electron daemon (unverified on a Mac)', async () => {
    const mac = async (_f: string, args: string[]) => (args[0] === '--getglobalstate' ? '(State = 1)' : args[0] === '--getblockall' ? 'disabled' : 'x is blocked');
    expect((await run(mac, { platform: 'darwin', exe: '/usr/local/bin/node' })).refusal).toBe('node-daemon');
    expect((await run(mac, { platform: 'darwin', exe: '/Users/me/wmux/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' })).refusal).toBe('not-wmux-exe');
  });

  it('Linux has nothing to check', async () => {
    const s = await run(async () => { throw new Error('must not run'); }, { platform: 'linux' });
    expect(s).toMatchObject({ platform: 'other', applicable: false, refusal: 'unsupported-platform' });
  });
});
