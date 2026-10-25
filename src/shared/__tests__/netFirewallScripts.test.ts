import { describe, it, expect } from 'vitest';
import {
  FirewallInputError,
  buildFixScript,
  buildMacFixAppleScript,
  buildProbeScript,
  buildRemoveScript,
  elevatedPowerShellParameters,
  exeRefusal,
  firewallRuleIds,
  installRootOf,
  psQuote,
  ruleHash,
  windowsPowerShellPath,
  type FixScriptInput,
  type RuleScope,
} from '../netFirewallScripts';
import type { FirewallListener } from '../netFirewall';

const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe';
const SCOPE: RuleScope = { dataSuffix: '', user: 'DESK\\me', group: 'wmux' };
const exists = (): boolean => true;

function fix(over: Partial<FixScriptInput> = {}): string {
  const exe = over.exe ?? EXE;
  return buildFixScript({ listener: 'a2a', port: 45660, exe, reportedExe: exe, tailnet: false, scope: SCOPE, exists, ...over });
}
function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FirewallInputError ? err.reason : `other: ${String(err)}`;
  }
}

// Every script must run under Constrained Language Mode: no .NET type
// literal (`[System.IO.Path]::…`) and no method call (`.StartsWith(`).
const DOTNET_TYPE = /\[[A-Za-z][A-Za-z.]*\]::/;
const METHOD_CALL = /\.[A-Za-z_]\w*\(/;

const ALL_SCRIPTS = (): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const listener of ['a2a', 'web', 'lanlink'] as FirewallListener[]) {
    for (const tailnet of [false, true]) out.push([`fix ${listener} tailnet=${tailnet}`, fix({ listener, tailnet })]);
    out.push([`remove ${listener}`, buildRemoveScript({ listener, exe: EXE, reportedExe: EXE, scope: SCOPE, exists })]);
    out.push([
      `probe ${listener}`,
      buildProbeScript({ exe: EXE, port: 45660, ips: ['192.168.1.10', '100.79.244.107'], ruleIds: firewallRuleIds(listener, EXE, SCOPE), legacyScan: listener === 'lanlink' }),
    ]);
  }
  return out;
};

describe('buildFixScript', () => {
  it('the A2A Fix, exactly', () => {
    expect(fix()).toBe(
      "$ErrorActionPreference='Stop'; $exe='C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe'; $root='C:\\Users\\me\\AppData\\Local\\wmux'; $g='wmux'; " +
        "try { Remove-NetFirewallRule -Name 'wmux-a2a-1451d14d-allow','wmux-a2a-1451d14d-pubblock' -ErrorAction SilentlyContinue; " +
        "Get-NetFirewallRule -Group $g -ErrorAction SilentlyContinue | Where-Object { $p=($_ | Get-NetFirewallApplicationFilter).Program; ($p -ne 'Any') -and -not (Test-Path -LiteralPath $p) } | Remove-NetFirewallRule -ErrorAction Stop; " +
        "Get-NetFirewallRule -DisplayName 'wmux LanLink (Private)','wmux LanLink (Public deny)' -ErrorAction SilentlyContinue | Where-Object { $p=($_ | Get-NetFirewallApplicationFilter).Program; (-not (Test-Path -LiteralPath $p)) -or ((Split-Path -Parent $p) -eq $root) -or ((Split-Path -Parent (Split-Path -Parent $p)) -eq $root) } | Remove-NetFirewallRule -ErrorAction Stop } catch { exit 10 }; " +
        "try { New-NetFirewallRule -Name 'wmux-a2a-1451d14d-allow' -Group $g -DisplayName 'wmux A2A inbound (TCP 45660)' -Description ('Created by wmux (' + $root + ') when you pressed Allow through firewall. Remove it from wmux: Remote > Details.') -Direction Inbound -Action Allow -Protocol TCP -LocalPort 45660 -Program $exe -Profile Private -RemoteAddress 'LocalSubnet' -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null } catch { exit 11 }; " +
        "try { New-NetFirewallRule -Name 'wmux-a2a-1451d14d-pubblock' -Group $g -DisplayName 'wmux A2A block on public networks (TCP 45660)' -Description ('Created by wmux (' + $root + ') when you pressed Allow through firewall. Remove it from wmux: Remote > Details.') -Direction Inbound -Action Block -Protocol TCP -LocalPort 45660 -Program $exe -Profile Public -ErrorAction Stop | Out-Null } catch { exit 12 }; exit 0",
    );
  });

  it('adds the tailnet range only when offered, and names each listener', () => {
    expect(fix({ tailnet: true })).toContain("-RemoteAddress 'LocalSubnet','100.64.0.0/10'");
    expect(fix({ tailnet: false })).not.toContain('100.64.0.0/10');
    expect(fix({ listener: 'web', port: 7681 })).toContain("-DisplayName 'wmux web inbound (TCP 7681)'");
    expect(fix({ listener: 'lanlink', port: 45651 })).toContain("-DisplayName 'wmux LanLink block on public networks (TCP 45651)'");
  });

  it('exits 10, 11 and 12 per stage, in that order', () => {
    const s = fix();
    const at = (n: number) => s.indexOf(`exit ${n} }`);
    expect(at(10)).toBeGreaterThan(0);
    expect(at(11)).toBeGreaterThan(at(10));
    expect(at(12)).toBeGreaterThan(at(11));
    expect(s.endsWith('exit 0')).toBe(true);
  });

  it('the Allow is Private + LocalSubnet without edge traversal; the Block is Public; Domain is never named', () => {
    const s = fix();
    expect(s).toMatch(/-Action Allow -Protocol TCP -LocalPort 45660 -Program \$exe -Profile Private -RemoteAddress 'LocalSubnet' -EdgeTraversalPolicy Block/);
    expect(s).toMatch(/-Action Block -Protocol TCP -LocalPort 45660 -Program \$exe -Profile Public /);
    expect(s).not.toMatch(/Domain|-Profile Any/);
  });
});

describe('every script', () => {
  it('is one CLM-safe line under 4 KB with no double quote', () => {
    for (const [name, s] of ALL_SCRIPTS()) {
      expect(DOTNET_TYPE.test(s), name).toBe(false);
      expect(METHOD_CALL.test(s), name).toBe(false);
      expect(/[\r\n]/.test(s), name).toBe(false);
      expect(s.includes('"'), name).toBe(false);
      expect(s.length, name).toBeLessThanOrEqual(4096);
    }
  });

  it('never encodes, uses netsh, flips a network profile or opens Any profile', () => {
    for (const [name, s] of ALL_SCRIPTS()) {
      expect(s, name).not.toMatch(/EncodedCommand|netsh|Set-NetConnectionProfile|-Profile Any|ExecutionPolicy/i);
    }
  });

  it('removes only by our IDs, or from a -Group/-DisplayName pipeline filtered by Where-Object', () => {
    const BY_NAME = /Remove-NetFirewallRule -Name 'wmux-(a2a|web|lanlink)-([0-9a-f]{8})-allow','wmux-\1-\2-pubblock' -ErrorAction SilentlyContinue/g;
    const PIPED = /Get-NetFirewallRule -(?:Group \$g|DisplayName 'wmux LanLink \(Private\)','wmux LanLink \(Public deny\)') -ErrorAction SilentlyContinue \| Where-Object \{ [^}]+ \} \| Remove-NetFirewallRule -ErrorAction Stop/g;
    for (const [name, s] of ALL_SCRIPTS()) {
      const removes = s.match(/Remove-NetFirewallRule/g)?.length ?? 0;
      const allowed = (s.match(BY_NAME)?.length ?? 0) + (s.match(PIPED)?.length ?? 0);
      expect(allowed, name).toBe(removes);
      // -Group and -DisplayName mix parameter sets and abort under Stop when nothing matches.
      for (const cmd of s.matchAll(/Get-NetFirewallRule [^|;]*/g)) {
        expect(/-Group\b/.test(cmd[0]) && /-DisplayName\b/.test(cmd[0]), `${name}: ${cmd[0]}`).toBe(false);
      }
      // The group pipeline always filters to rules whose program is gone.
      for (const m of s.matchAll(/Get-NetFirewallRule -Group \$g [^|]*\| Where-Object \{ ([^}]*) \}/g)) {
        expect(m[1]).toContain('-not (Test-Path -LiteralPath $p)');
        expect(m[1]).toContain("($p -ne 'Any')");
      }
    }
  });

  it('the Remove script touches only this listener\'s pair', () => {
    const s = buildRemoveScript({ listener: 'web', exe: EXE, reportedExe: EXE, scope: SCOPE, exists });
    const ids = firewallRuleIds('web', EXE, SCOPE);
    expect(s).toBe(`Remove-NetFirewallRule -Name '${ids.allow}','${ids.pubblock}' -ErrorAction SilentlyContinue; exit 0`);
  });
});

describe('psQuote and the inputs it refuses', () => {
  it('doubles ASCII and smart single quotes; Hangul passes unchanged', () => {
    expect(psQuote("C:\\Users\\O'Brien\\wmux.exe")).toBe("'C:\\Users\\O''Brien\\wmux.exe'");
    expect(psQuote('C:\\Users\\O\u2019Brien\\wmux.exe')).toBe("'C:\\Users\\O\u2019\u2019Brien\\wmux.exe'");
    expect(psQuote('C:\\Users\\a\u2018b\u201ac\u201bd')).toBe("'C:\\Users\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd'");
    expect(psQuote('C:\\Users\\홍길동\\wmux.exe')).toBe("'C:\\Users\\홍길동\\wmux.exe'");
  });

  it('refuses $, backtick, double quotes (ASCII and smart), CR, LF and tab', () => {
    for (const bad of ['a$b', 'a`b', 'a"b', 'a\rb', 'a\nb', 'a\tb', 'a\u201cb', 'a\u201db', 'a\u201eb']) {
      expect(refusalOf(() => psQuote(bad)), JSON.stringify(bad)).toBe('bad-path');
    }
  });

  it('the Fix carries quoted fixtures intact and refuses the bad ones', () => {
    const obrien = 'C:\\Users\\O\'Brien\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe';
    expect(fix({ exe: obrien })).toContain("$exe='C:\\Users\\O''Brien\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe'");
    expect(fix({ exe: obrien })).toContain("$root='C:\\Users\\O''Brien\\AppData\\Local\\wmux'");
    const hangul = 'C:\\Users\\홍길동\\AppData\\Local\\wmux\\app-1.2.3\\wmux.exe';
    expect(fix({ exe: hangul })).toContain(`$exe='${hangul}'`);
    const smart = 'C:\\Users\\O\u2019Brien\\wmux\\wmux.exe';
    expect(fix({ exe: smart })).toContain("$exe='C:\\Users\\O\u2019\u2019Brien\\wmux\\wmux.exe'");
    for (const bad of ['C:\\Users\\$me\\wmux.exe', 'C:\\Users\\a`b\\wmux.exe', 'C:\\Users\\a"b\\wmux.exe', 'C:\\Users\\a\rb\\wmux.exe', 'C:\\Users\\a\nb\\wmux.exe', 'C:\\Users\\a\u201cb\\wmux.exe']) {
      expect(refusalOf(() => fix({ exe: bad })), JSON.stringify(bad)).toBe('bad-path');
    }
  });

  it('refuses a program that is not the daemon\'s reported execPath', () => {
    expect(refusalOf(() => fix({ exe: EXE, reportedExe: 'C:\\Other\\wmux.exe' }))).toBe('bad-input');
  });

  it('refuses node.exe, a non-wmux program, a relative or missing path, and a bad port', () => {
    expect(refusalOf(() => fix({ exe: 'C:\\Program Files\\nodejs\\node.exe' }))).toBe('node-daemon');
    expect(refusalOf(() => fix({ exe: 'D:\\wmux\\node_modules\\electron\\dist\\electron.exe' }))).toBe('not-wmux-exe');
    expect(refusalOf(() => fix({ exe: 'wmux.exe' }))).toBe('exe-missing');
    expect(refusalOf(() => fix({ exe: '\\\\server\\share\\wmux.exe' }))).toBe('exe-missing');
    expect(refusalOf(() => fix({ exists: () => false }))).toBe('exe-missing');
    for (const port of [0, 80, 1023, 65536, 45660.5]) expect(refusalOf(() => fix({ port })), String(port)).toBe('bad-input');
    expect(exeRefusal('C:\\x\\NODE.EXE', exists)).toBe('node-daemon');
    expect(exeRefusal(EXE, exists)).toBeNull();
  });
});

describe('rule IDs', () => {
  it('Squirrel app-X.Y.Z maps to its parent; other layouts keep the exe folder', () => {
    expect(installRootOf(EXE)).toBe('C:\\Users\\me\\AppData\\Local\\wmux');
    expect(installRootOf('C:\\Users\\me\\AppData\\Local\\wmux\\app-4.11.0-beta.1\\wmux.exe')).toBe('C:\\Users\\me\\AppData\\Local\\wmux');
    expect(installRootOf('D:\\portable\\wmux\\wmux.exe')).toBe('D:\\portable\\wmux');
  });

  it('is stable across updates, case-insensitive on the root, and differs by instance and user', () => {
    const a = firewallRuleIds('a2a', EXE, SCOPE);
    expect(a).toEqual({ base: 'wmux-a2a-1451d14d', allow: 'wmux-a2a-1451d14d-allow', pubblock: 'wmux-a2a-1451d14d-pubblock' });
    expect(firewallRuleIds('a2a', EXE.replace('app-4.10.0', 'app-4.11.0'), SCOPE)).toEqual(a);
    expect(ruleHash('C:\\USERS\\ME\\APPDATA\\LOCAL\\WMUX', '', 'DESK\\me')).toBe(ruleHash('c:\\users\\me\\appdata\\local\\wmux', '', 'DESK\\me'));
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, dataSuffix: '-dev' }).base).not.toBe(a.base);
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, user: 'DESK\\other' }).base).not.toBe(a.base);
    expect(firewallRuleIds('web', EXE, SCOPE).base).toBe('wmux-web-1451d14d');
    expect(firewallRuleIds('a2a', EXE, { ...SCOPE, group: 'wmux-ci' }).base).toBe('wmux-ci-a2a-1451d14d');
  });
});

describe('the probe', () => {
  it('quotes the exe and validates the address list', () => {
    const s = buildProbeScript({ exe: EXE, port: 45660, ips: [], ruleIds: firewallRuleIds('a2a', EXE, SCOPE), legacyScan: false });
    expect(s).toContain(`$exe='${EXE}'`);
    expect(s).toContain('$ips=@()');
    expect(s).toContain("$o['legacy']=0");
    expect(refusalOf(() => buildProbeScript({ exe: EXE, port: 45660, ips: ["1.2.3.4'; Remove-Item x; '"], ruleIds: firewallRuleIds('a2a', EXE, SCOPE), legacyScan: false }))).toBe('bad-input');
  });

  it('scans for the legacy LanLink rules only when asked', () => {
    const s = buildProbeScript({ exe: EXE, port: 45651, ips: ['10.0.0.5'], ruleIds: firewallRuleIds('lanlink', EXE, SCOPE), legacyScan: true });
    expect(s).toContain("Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $legacyNames");
  });
});

describe('elevation command line', () => {
  it('passes the script as one double-quoted -Command argument, hidden, no profile', () => {
    expect(elevatedPowerShellParameters('exit 0')).toBe('-NoProfile -NonInteractive -WindowStyle Hidden -Command "exit 0"');
    expect(refusalOf(() => elevatedPowerShellParameters('exit "0"'))).toBe('bad-input');
  });

  it('runs the absolute System32 Windows PowerShell', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('macOS Fix (unverified on a Mac)', () => {
  it('quotes the app path for the shell inside AppleScript', () => {
    expect(buildMacFixAppleScript('/Applications/wmux.app/Contents/MacOS/wmux')).toBe(
      "do shell script \"/usr/libexec/ApplicationFirewall/socketfilterfw --add '/Applications/wmux.app/Contents/MacOS/wmux' --unblockapp '/Applications/wmux.app/Contents/MacOS/wmux'\" with administrator privileges",
    );
    for (const bad of ["/A/b'c", '/A/b"c', '/A/b\\c', '/A/b\nc', 'relative', '/A/$x']) {
      expect(refusalOf(() => buildMacFixAppleScript(bad)), JSON.stringify(bad)).toBe('bad-path');
    }
  });
});
