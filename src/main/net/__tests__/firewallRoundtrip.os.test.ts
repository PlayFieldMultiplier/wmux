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
// whatever happened. Every rule outside that group is listed first and must
// be exactly the same after each Fix, Remove and the cleanup: an empty
// pipeline must never reach Remove-NetFirewallRule without a filter.
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
let shortRoot = '';
let exe = '';
let otherLiveExe = '';

/** The probe as the daemon runs it, with no advertised address (judged on Private). */
async function verdict(port = PORT, tailnet = false): Promise<string> {
  const ids = firewallRuleIds('a2a', exe, SCOPE);
  const r = await ps(buildProbeScript({ exe, port, ips: [], ruleIds: ids, legacyScan: false }));
  expect(r.code, r.stderr).toBe(0);
  const facts = parseProbeLine(r.stdout);
  if (!facts) throw new Error(`unreadable probe line: ${r.stdout}`);
  return assessInbound(facts, { recorded: null, exe, ruleBase: ids.base, tailnet }).verdict;
}

/** Read-only: the sorted names of every local rule outside group wmux-ci. */
async function rulesOutsideCi(): Promise<string> {
  const r = await ps(
    `@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object { $_.Group -ne ${psQuote(FIREWALL_CI_GROUP)} } | Sort-Object Name | ForEach-Object { $_.Name }) -join ','`,
  );
  expect(r.code, r.stderr).toBe(0);
  return r.stdout.trim();
}
let outsideBefore = '';

/**
 * The parameter-set diagnostic's rule names. Two have no group (they test
 * -Group itself), so they are removed by name here, in afterAll and by the
 * workflow's cleanup step.
 */
const DIAG_NAMES = Array.from({ length: 12 }, (_, i) => `wmux-ci-diag-${String(i + 1).padStart(2, '0')}`);
const removeDiagRules = () => ps(`Remove-NetFirewallRule -Name ${DIAG_NAMES.map((n) => psQuote(n)).join(',')} -ErrorAction SilentlyContinue`);

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

function fix(port: number, tailnet = false): string {
  return buildFixScript({ listener: 'a2a', port, exe, reportedExe: exe, tailnet, scope: SCOPE, facts: FACTS });
}

describe.runIf(RUN)('firewall Fix round trip (CI runner only, group wmux-ci)', () => {
  beforeAll(async () => {
    outsideBefore = await rulesOutsideCi();
    expect(outsideBefore.length).toBeGreaterThan(0);
    // The runner's TEMP is an 8.3 short path (C:\Users\RUNNER~1\…); a real
    // install path never is, so the round trip uses the long form.
    shortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ci-fw-'));
    root = fs.realpathSync.native(shortRoot);
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
    await removeDiagRules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (outsideBefore) expect(await rulesOutsideCi()).toBe(outsideBefore);
  }, 120_000);

  it('runs as an administrator (the round trip needs one)', async () => {
    const r = await ps("if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'admin' } else { 'user' }");
    expect(r.stdout.trim()).toBe('admin');
  }, 120_000);

  // Diagnostic, not a check: which New-NetFirewallRule parameter sets this
  // runner accepts. Run 40161566034 (windows-2025-vs2026) rejected the
  // test's own setup rules and the Fix's Allow with Windows error 87 ("The
  // parameter is incorrect"). Each variant adds one parameter to a minimal
  // rule; the log line says which are refused. Every rule is removed by name
  // right after.
  it('diagnostic: which rule parameter sets this runner accepts (logged, never fails)', async () => {
    const shortExe = path.join(shortRoot, 'wmux', 'app-1.2.3', 'wmux.exe');
    const longMissing = path.join(root, 'gone', 'app-0.0.1', 'wmux.exe');
    const base = (i: number, group = true) =>
      `-Name ${psQuote(DIAG_NAMES[i])}${group ? ` -Group ${psQuote(FIREWALL_CI_GROUP)}` : ''} -DisplayName ${psQuote(`wmux-ci diag ${i + 1}`)} -Direction Inbound -Action Allow`;
    const variants: Array<[string, string]> = [
      ['minimal, no group', base(0, false)],
      ['+ -Group', base(1)],
      ['+ -Protocol TCP -LocalPort', `${base(2)} -Protocol TCP -LocalPort 45697`],
      ['+ -Profile Private', `${base(3)} -Profile Private`],
      ['+ -Program System32 cmd.exe', `${base(4)} -Program ${psQuote('C:\\Windows\\System32\\cmd.exe')}`],
      ['+ -Program long temp path (exists)', `${base(5)} -Program ${psQuote(exe)}`],
      ['+ -Program 8.3 temp path (exists)', `${base(6)} -Program ${psQuote(shortExe)}`],
      ['+ -Program long temp path (missing)', `${base(7)} -Program ${psQuote(longMissing)}`],
      ['+ -Program long temp path, no group', `${base(8, false)} -Program ${psQuote(exe)}`],
      ['setup rule shape, long path', `${base(9)} -Protocol TCP -LocalPort 45697 -Program ${psQuote(exe)} -Profile Private`],
      ['setup rule shape, 8.3 path', `${base(10)} -Protocol TCP -LocalPort 45697 -Program ${psQuote(shortExe)} -Profile Private`],
      ['Fix Allow shape, long path', `${base(11)} -Description 'wmux-ci diag' -Protocol TCP -LocalPort 45697 -Program ${psQuote(exe)} -Profile Private -RemoteAddress 'LocalSubnet','100.64.0.0/10' -EdgeTraversalPolicy Block`],
    ];
    const results: Array<{ variant: string; ok: boolean; error?: string }> = [];
    try {
      for (const [variant, params] of variants) {
        const r = await ps(`try { New-NetFirewallRule ${params} -ErrorAction Stop | Out-Null; 'ok' } catch { 'fail: ' + $_.Exception.Message }`);
        const out = r.stdout.trim();
        results.push(out === 'ok' ? { variant, ok: true } : { variant, ok: false, error: out.replace(/^fail: /, '') || r.stderr.trim() });
      }
    } finally {
      await removeDiagRules();
    }
    console.log(`[firewall-diag] temp=${shortRoot} long=${root}`);
    for (const r of results) console.log(`[firewall-diag] ${r.ok ? 'accepted' : 'REJECTED'}: ${r.variant}${r.error ? ` — ${r.error}` : ''}`);
    expect(await ruleCount(DIAG_NAMES[0])).toBe(0);
  }, 180_000);

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
    expect(await rulesOutsideCi()).toBe(outsideBefore);
  }, 180_000);

  it('a tailnet address: a LocalSubnet-only Allow no longer covers; the Fix adds 100.64.0.0/10 and the probe sees it', async () => {
    expect(await verdict(PORT, true)).toBe('not-covered');
    const r = await ps(fix(PORT, true));
    expect(r.code, r.stderr).toBe(0);
    const remote = (await ruleFields(firewallRuleIds('a2a', exe, SCOPE).allow))['remote'] as string[];
    expect(remote).toHaveLength(2);
    expect(remote).toContain('LocalSubnet');
    expect(remote.some((a) => a === '100.64.0.0/10' || a === '100.64.0.0/255.192.0.0'), remote.join(' ')).toBe(true);
    expect(await verdict(PORT, true)).toBe('covered');
    expect(await rulesOutsideCi()).toBe(outsideBefore);
  }, 180_000);

  it('a port change: the next Fix replaces the pair (same IDs), under Constrained Language Mode', async () => {
    const ids = firewallRuleIds('a2a', exe, SCOPE);
    const r = await ps(CLM_PREFIX + fix(NEW_PORT));
    expect(r.code, r.stderr).toBe(0);
    expect(await ruleCount(ids.allow)).toBe(1);
    expect((await ruleFields(ids.allow))['port']).toBe(String(NEW_PORT));
    expect((await ruleFields(ids.pubblock))['port']).toBe(String(NEW_PORT));
    expect(await rulesOutsideCi()).toBe(outsideBefore);
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
    expect(await rulesOutsideCi()).toBe(outsideBefore);
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
    expect(await rulesOutsideCi()).toBe(outsideBefore);
  }, 180_000);
});

describe.runIf(!RUN)('firewall Fix round trip', () => {
  it('is skipped outside the CI runner step that sets WMUX_FIREWALL_ROUNDTRIP=1', () => {
    expect(RUN).toBe(false);
  });
});
