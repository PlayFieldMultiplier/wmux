// The firewall Fix for real: create, probe and remove Windows Firewall rules.
//
// ONLY on the CI Windows runner, a disposable VM whose user is an
// administrator with UAC off. It runs when BOTH GITHUB_ACTIONS=true and
// WMUX_FIREWALL_ROUNDTRIP=1, and the second is set only by the dedicated step
// in .github/workflows/windows.yml. Never set it on a developer's machine:
// this test writes firewall rules.
//
// Every rule it makes is in group `wmux-ci` with IDs prefixed `wmux-ci-`
// (never the real `wmux` group), and `afterAll` removes the whole group
// whatever happened.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIREWALL_CI_GROUP,
  LEGACY_LANLINK_RULES,
  buildFixScript,
  buildProbeScript,
  buildRemoveScript,
  currentRuleUser,
  elevatedPowerShellParameters,
  firewallRuleIds,
  psQuote,
  windowsPowerShellPath,
  type PathFacts,
  type RuleScope,
} from '../../../shared/netFirewallScripts';
import { assessInbound, elevationOutcome, parseProbeLine } from '../../../shared/netFirewall';
import { onLocalFixedDrive, systemDirectory } from '../../../shared/netWinPaths';
import { shellExecuteAndWait } from '../elevate';

const RUN = process.platform === 'win32' && process.env['GITHUB_ACTIONS'] === 'true' && process.env['WMUX_FIREWALL_ROUNDTRIP'] === '1';

const SCOPE: RuleScope = { dataSuffix: '-ci', user: currentRuleUser(), group: FIREWALL_CI_GROUP };
const PORT = 45699;
const NEW_PORT = 45698;
const CLM_PREFIX = "Import-Module NetSecurity,Microsoft.PowerShell.Management; $ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; ";
const FACTS: PathFacts = { exists: (p) => fs.existsSync(p), onLocalFixedDrive };
const powershell = (): string => windowsPowerShellPath(systemDirectory() ?? 'C:\\Windows\\System32');

function ps(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

let root = '';
let exe = '';
let otherLiveExe = '';

/** The probe as the daemon runs it, with no advertised address (judged on Private). */
async function verdict(): Promise<string> {
  const ids = firewallRuleIds('a2a', exe, SCOPE);
  const r = await ps(buildProbeScript({ exe, port: PORT, ips: [], ruleIds: ids, legacyScan: false }));
  expect(r.code, r.stderr).toBe(0);
  const facts = parseProbeLine(r.stdout);
  if (!facts) throw new Error(`unreadable probe line: ${r.stdout}`);
  return assessInbound(facts, { recorded: null, exe, ruleBase: ids.base, tailnet: false }).verdict;
}

/** Read-only: how many rules have this Name (0 or 1). */
async function ruleCount(name: string): Promise<number> {
  const r = await ps(`@(Get-NetFirewallRule -Name ${psQuote(name)} -ErrorAction SilentlyContinue).Count`);
  return Number(r.stdout.trim());
}

async function ruleFields(name: string): Promise<Record<string, unknown>> {
  const r = await ps(
    `$r = Get-NetFirewallRule -Name ${psQuote(name)}; $p = $r | Get-NetFirewallPortFilter; $a = $r | Get-NetFirewallApplicationFilter; $ad = $r | Get-NetFirewallAddressFilter; ` +
      "@{ group = $r.Group; action = '' + $r.Action; direction = '' + $r.Direction; profile = '' + $r.Profile; edge = '' + $r.EdgeTraversalPolicy; protocol = '' + $p.Protocol; port = '' + $p.LocalPort; program = $a.Program; remote = @($ad.RemoteAddress) } | ConvertTo-Json -Compress",
  );
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function fix(port: number): string {
  return buildFixScript({ listener: 'a2a', port, exe, reportedExe: exe, tailnet: false, scope: SCOPE, facts: FACTS });
}

describe.runIf(RUN)('firewall Fix round trip (CI runner only, group wmux-ci)', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ci-fw-'));
    // A Squirrel-shaped install: the rule IDs come from the parent of app-X.Y.Z.
    exe = path.join(root, 'wmux', 'app-1.2.3', 'wmux.exe');
    otherLiveExe = path.join(root, 'other', 'app-9.9.9', 'wmux.exe');
    for (const f of [exe, otherLiveExe]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '');
    }
  });

  afterAll(async () => {
    // Unconditional: whatever the test made, in its own group only.
    await ps(`Remove-NetFirewallRule -Group ${psQuote(FIREWALL_CI_GROUP)} -ErrorAction SilentlyContinue`);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('runs as an administrator (the round trip needs one)', async () => {
    const r = await ps("if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'admin' } else { 'user' }");
    expect(r.stdout.trim()).toBe('admin');
  }, 120_000);

  it('a Fix through ShellExecuteExW runas: not-covered → covered, with the rule fields of the design', async () => {
    const ids = firewallRuleIds('a2a', exe, SCOPE);
    expect(ids.base.startsWith('wmux-ci-a2a-')).toBe(true);
    expect(await verdict()).toBe('not-covered');

    const run = await shellExecuteAndWait({ verb: 'runas', file: powershell(), parameters: elevatedPowerShellParameters(fix(PORT)), hwnd: null });
    expect(elevationOutcome(run)).toEqual({ kind: 'ok' });
    expect(await verdict()).toBe('covered');

    const allow = await ruleFields(ids.allow);
    expect(allow).toMatchObject({ group: FIREWALL_CI_GROUP, action: 'Allow', direction: 'Inbound', profile: 'Private', edge: 'Block', protocol: 'TCP', port: String(PORT), program: exe });
    expect(allow['remote']).toEqual(['LocalSubnet']);
    const block = await ruleFields(ids.pubblock);
    expect(block).toMatchObject({ group: FIREWALL_CI_GROUP, action: 'Block', profile: 'Public', protocol: 'TCP', port: String(PORT), program: exe });
  }, 180_000);

  it('a port change: the next Fix replaces the pair (same IDs), under Constrained Language Mode', async () => {
    const ids = firewallRuleIds('a2a', exe, SCOPE);
    const r = await ps(CLM_PREFIX + fix(NEW_PORT));
    expect(r.code, r.stderr).toBe(0);
    expect(await ruleCount(ids.allow)).toBe(1);
    expect((await ruleFields(ids.allow))['port']).toBe(String(NEW_PORT));
    expect((await ruleFields(ids.pubblock))['port']).toBe(String(NEW_PORT));
  }, 180_000);

  it('stage 10 removes dead-path group rules and dead legacy rules, and keeps another live install\'s', async () => {
    const dead = path.join(root, 'gone', 'app-0.0.1', 'wmux.exe');
    const make = (name: string, display: string, program: string) =>
      `New-NetFirewallRule -Name ${psQuote(name)} -Group ${psQuote(FIREWALL_CI_GROUP)} -DisplayName ${psQuote(display)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort 45690 -Program ${psQuote(program)} -Profile Private | Out-Null`;
    const setup = await ps([
      make('wmux-ci-dead-1', 'wmux-ci dead path', dead),
      make('wmux-ci-live-1', 'wmux-ci other live install', otherLiveExe),
      make('wmux-ci-legacy-dead', LEGACY_LANLINK_RULES[0], dead),
      make('wmux-ci-legacy-live', LEGACY_LANLINK_RULES[1], otherLiveExe),
    ].join('; '));
    expect(setup.code, setup.stderr).toBe(0);

    const r = await ps(fix(PORT));
    expect(r.code, r.stderr).toBe(0);
    expect(await ruleCount('wmux-ci-dead-1')).toBe(0);
    expect(await ruleCount('wmux-ci-legacy-dead')).toBe(0);
    // Another install's rules are not ours to remove.
    expect(await ruleCount('wmux-ci-live-1')).toBe(1);
    expect(await ruleCount('wmux-ci-legacy-live')).toBe(1);
  }, 180_000);

  it('Remove takes this listener\'s pair away and nothing else', async () => {
    const ids = firewallRuleIds('a2a', exe, SCOPE);
    const run = await shellExecuteAndWait({
      verb: 'runas',
      file: powershell(),
      parameters: elevatedPowerShellParameters(buildRemoveScript({ listener: 'a2a', exe, reportedExe: exe, scope: SCOPE, facts: FACTS })),
      hwnd: null,
    });
    expect(elevationOutcome(run)).toEqual({ kind: 'ok' });
    expect(await ruleCount(ids.allow)).toBe(0);
    expect(await ruleCount(ids.pubblock)).toBe(0);
    expect(await ruleCount('wmux-ci-live-1')).toBe(1);
    expect(await verdict()).toBe('not-covered');
  }, 180_000);
});

describe.runIf(!RUN)('firewall Fix round trip', () => {
  it('is skipped outside the CI runner step that sets WMUX_FIREWALL_ROUNDTRIP=1', () => {
    expect(RUN).toBe(false);
  });
});
