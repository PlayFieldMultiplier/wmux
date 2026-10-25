// === The read-only firewall probe (`net.inboundStatus`) ===
//
// Runs in the daemon, which owns the facts: the port, the program path
// (process.execPath of this daemon) and the addresses another PC is told to
// use. Only on a deliberate event (the Remote page opening, Check firewall,
// after a Fix, a port change, a listener restart) — never on a poll: the
// Windows probe is one powershell.exe that costs 2-4 s warm and more cold.
//
// Windows: one non-elevated Windows PowerShell 5.1 by absolute path, the
// script from netFirewallScripts.ts, an 8 s deadline. A timeout, a failed
// spawn or an unreadable line is `unknown`, which the UI says plainly.
// macOS: three socketfilterfw reads (verify on Mac). Elsewhere: nothing to
// check; the static hint stays.
//
// Imports node builtins and shared modules only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {
  assessInbound,
  assessMac,
  inapplicableStatus,
  isIpv4,
  markVirtual,
  parseMacFirewall,
  parseProbeLine,
  type FirewallListener,
  type FirewallPlatform,
  type InboundStatus,
} from '../../shared/netFirewall';
import {
  FirewallInputError,
  SOCKETFILTERFW,
  buildProbeScript,
  exeRefusal,
  firewallRuleIds,
  windowsPowerShellPath,
  type RuleScope,
} from '../../shared/netFirewallScripts';
import type { FirewallRuleRecord } from './firewallRecord';

/** The probe's deadline: past it the answer is `unknown` ("Could not read the firewall settings"). */
export const PROBE_TIMEOUT_MS = 8_000;

/** What a listener tells the probe about itself. */
export interface ProbeTarget {
  listener: FirewallListener;
  /** Listening, and (web) reachable beyond loopback. Otherwise there is nothing to check. */
  applicable: boolean;
  port: number | null;
  /** The IPv4s another PC is told to connect to. */
  ips: string[];
  inboundSeenAt: number | null;
}

export type ProbeExec = (file: string, args: string[], opts: { timeout: number }) => Promise<string>;

const defaultExec: ProbeExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      // stderr is in the console codepage; the exit and Node's message say enough.
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  /** The daemon's program path (process.execPath). */
  exe?: string;
  scope: RuleScope;
  /** firewall-rules.json's entry for this listener. */
  record: (listener: FirewallListener) => FirewallRuleRecord | null;
  exec?: ProbeExec;
  ifaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  exists?: (p: string) => boolean;
  now?: () => number;
  log?: (msg: string) => void;
}

function platformOf(p: NodeJS.Platform): FirewallPlatform {
  return p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'other';
}

/** IPv4 → the adapter name Node reports (decoded correctly, unlike a console codepage). */
export function adapterNames(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !out.has(a.address)) out.set(a.address, name);
  }
  return out;
}

function uniqueNames(ips: string[], names: Map<string, string>): string[] {
  return [...new Set(ips.map((ip) => names.get(ip) ?? ip))];
}

export async function probeInbound(target: ProbeTarget, deps: ProbeDeps): Promise<InboundStatus> {
  const platform = platformOf(deps.platform ?? process.platform);
  const exe = deps.exe ?? process.execPath;
  const now = deps.now ?? Date.now;
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  if (platform === 'other') return inapplicableStatus(target.listener, platform, exe, now());
  if (!target.applicable || target.port === null) {
    return { ...inapplicableStatus(target.listener, platform, exe, now()), inboundSeenAt: target.inboundSeenAt };
  }
  const base: InboundStatus = {
    ...inapplicableStatus(target.listener, platform, exe, now()),
    applicable: true,
    port: target.port,
    inboundSeenAt: target.inboundSeenAt,
  };

  if (platform === 'darwin') {
    // Verify on Mac: the reads may need no root, and the app path the
    // firewall knows may be the bundle rather than the binary.
    base.refusal = exe.startsWith('/') ? null : 'exe-missing';
    try {
      const [g, b, a] = await Promise.all([
        exec(SOCKETFILTERFW, ['--getglobalstate'], { timeout: PROBE_TIMEOUT_MS }),
        exec(SOCKETFILTERFW, ['--getblockall'], { timeout: PROBE_TIMEOUT_MS }),
        exec(SOCKETFILTERFW, ['--getappblocked', exe], { timeout: PROBE_TIMEOUT_MS }),
      ]);
      return { ...base, verdict: assessMac(parseMacFirewall(g, b, a)) };
    } catch (err) {
      log(`[net] firewall probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return base;
    }
  }

  const ids = firewallRuleIds(target.listener, exe, deps.scope);
  base.ruleIds = { allow: ids.allow, pubblock: ids.pubblock };
  base.refusal = exeRefusal(exe, exists);
  let script: string;
  try {
    script = buildProbeScript({
      exe,
      port: target.port,
      ips: target.ips.filter(isIpv4),
      ruleIds: ids,
      legacyScan: target.listener === 'lanlink',
    });
  } catch (err) {
    // A path the script cannot carry: nothing can be read, and no rule can be made.
    if (err instanceof FirewallInputError) return { ...base, refusal: base.refusal ?? 'bad-path' };
    throw err;
  }
  const started = now();
  let stdout: string;
  try {
    stdout = await exec(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: PROBE_TIMEOUT_MS });
  } catch (err) {
    log(`[net] firewall probe failed after ${now() - started} ms: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return base;
  }
  const parsed = parseProbeLine(stdout);
  if (!parsed) {
    log('[net] firewall probe answered an unreadable line');
    return base;
  }
  const names = adapterNames((deps.ifaces ?? os.networkInterfaces)());
  const facts = markVirtual(parsed, (ip) => names.get(ip) ?? null);
  const a = assessInbound(facts, { recordedExe: deps.record(target.listener)?.exe ?? null, exe });
  return {
    ...base,
    verdict: a.verdict,
    exposedPublic: a.exposedPublic,
    publicBlocked: a.publicBlocked,
    legacyLanLink: a.legacyLanLink,
    okNetworks: uniqueNames(a.okIps, names),
    publicNetworks: uniqueNames(a.publicIps, names),
    thirdPartyName: a.thirdPartyName,
  };
}
