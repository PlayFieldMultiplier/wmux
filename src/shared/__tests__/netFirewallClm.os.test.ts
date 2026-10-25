// The probe runs under Constrained Language Mode (managed PCs). This runs the
// real generated probe in a PowerShell child that switches itself to CLM
// first, and checks the line still parses. Read-only: the probe only reads
// the firewall.
//
// Setting the language mode by hand blocks module autoloading of the NetSecurity
// CDXML modules, which a real (WDAC/AppLocker) CLM session loads as trusted
// System32 modules. So the modules are imported first, in FullLanguage, and the
// generated script then runs constrained, which is what a managed PC does.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { buildProbeScript, firewallRuleIds, windowsPowerShellPath } from '../netFirewallScripts';
import { parseProbeLine } from '../netFirewall';

const CLM_PREFIX = "Import-Module NetSecurity,NetTCPIP,NetConnection,CimCmdlets; $ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; ";

function runPs(script: string): Promise<{ stdout: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      windowsPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60_000, encoding: 'utf8' },
      (err, stdout) => resolve({ stdout, failed: Boolean(err) }),
    );
  });
}

function externalIpv4s(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((l) => l ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

describe.runIf(process.platform === 'win32')('the firewall probe under Constrained Language Mode', () => {
  it('the harness really is constrained: a .NET static call fails', async () => {
    const r = await runPs(`${CLM_PREFIX}[System.IO.Path]::GetFileName('C:\\a\\b.txt')`);
    expect(r.failed).toBe(true);
  }, 60_000);

  for (const listener of ['a2a', 'lanlink'] as const) {
    it(`${listener}: the generated probe prints one parseable ASCII line`, async () => {
      const exe = process.execPath;
      const script = buildProbeScript({
        exe,
        port: 45699,
        ips: externalIpv4s(),
        ruleIds: firewallRuleIds(listener, exe, { dataSuffix: '-clmtest', user: 'TEST\\clm', group: 'wmux-ci' }),
        legacyScan: listener === 'lanlink',
      });
      const r = await runPs(CLM_PREFIX + script);
      expect(r.failed).toBe(false);
      const facts = parseProbeLine(r.stdout);
      expect(facts).not.toBeNull();
      expect(Object.keys(facts?.profiles ?? {}).sort()).toEqual(['Domain', 'Private', 'Public']);
    }, 60_000);
  }
});
