import { describe, it, expect } from 'vitest';
import {
  VERDICT_PRECEDENCE,
  allowHintKey,
  assessInbound,
  assessMac,
  elevationKind,
  elevationOutcome,
  failedError,
  firewallDetailsText,
  firewallOffer,
  inapplicableStatus,
  markVirtual,
  parseMacFirewall,
  parseProbeLine,
  partlyPublicSentence,
  pickVerdict,
  type InboundStatus,
  type AssessContext,
  type InboundVerdict,
  type ProbeFacts,
} from '../netFirewall';

const EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.10.0\\wmux.exe';
const OLD_EXE = 'C:\\Users\\me\\AppData\\Local\\wmux\\app-4.9.0\\wmux.exe';

const on = { en: 1, inb: 1, loc: 1 };
type RawRule = { act: string; prof: string; proto?: string; hit?: number; anyPort?: number; ours?: number; tn?: number; legacy?: number; src?: string };
function line(over: { prof?: Record<string, unknown>; addr?: unknown[]; rules?: RawRule[]; legacy?: number; tp?: number; tpName?: string | null } = {}): string {
  return JSON.stringify({
    v: 1,
    prof: over.prof ?? { Domain: on, Private: on, Public: on },
    addr: over.addr ?? [{ ip: '192.168.1.10', cat: 1 }],
    rules: (over.rules ?? []).map((r) => ({ proto: 'TCP', hit: 1, anyPort: 0, ours: 0, tn: 0, legacy: 0, src: 'Local', ...r })),
    legacy: over.legacy ?? 0,
    tp: over.tp ?? 0,
    tpName: over.tpName ?? null,
  });
}
function facts(over: Parameters<typeof line>[0] = {}): ProbeFacts {
  const f = parseProbeLine(line(over));
  if (!f) throw new Error('fixture did not parse');
  return f;
}
/** This install's rule ID base for A2A (any fixed value: the classifier only compares it). */
const BASE = 'wmux-a2a-1451d14d';
const ctx = (over: Partial<AssessContext> = {}): AssessContext => ({ recorded: null, exe: EXE, ruleBase: BASE, tailnet: false, ...over });
const verdict = (f: ProbeFacts, recordedExe: string | null = null, over: Partial<AssessContext> = {}): InboundVerdict =>
  assessInbound(f, ctx({ recorded: recordedExe ? { exe: recordedExe, id: BASE } : null, ...over })).verdict;

const OURS_ALLOW: RawRule = { act: 'Allow', prof: 'Private', ours: 1 };
const OURS_BLOCK: RawRule = { act: 'Block', prof: 'Public', ours: 1 };
const PROMPT_ALLOW_ANY: RawRule = { act: 'Allow', prof: 'Private, Public', anyPort: 1 };

describe('parseProbeLine', () => {
  it('reads a probe line from this box', () => {
    const f = parseProbeLine(
      '{"v":1,"addr":[{"ip":"100.79.244.107","cat":1},{"ip":"192.168.45.28","cat":0},{"ip":"172.17.48.1","cat":-1}],"rules":[{"hit":1,"ours":0,"tn":0,"prof":"Private, Public","legacy":0,"anyPort":1,"act":"Allow","src":"Local","proto":"TCP"},{"hit":1,"ours":0,"tn":0,"prof":"Private, Public","legacy":0,"anyPort":1,"act":"Allow","src":"Local","proto":"UDP"}],"tp":0,"prof":{"Private":{"inb":1,"en":1,"loc":1},"Domain":{"inb":1,"en":1,"loc":1},"Public":{"inb":1,"en":1,"loc":1}},"tpName":null,"legacy":0}\r\n',
    );
    expect(f?.addresses.map((a) => a.category)).toEqual(['Private', 'Public', 'None']);
    expect(f?.rules.map((r) => r.tcp)).toEqual([true, false]);
    expect(f?.rules[0].profiles).toEqual(['Private', 'Public']);
  });

  it('a malformed, non-ASCII, doubled or wrong-version line is null', () => {
    expect(parseProbeLine('')).toBeNull();
    expect(parseProbeLine('{"v":1,')).toBeNull();
    expect(parseProbeLine(line().replace('"v":1', '"v":2'))).toBeNull();
    expect(parseProbeLine(`${line()}\n${line()}`)).toBeNull();
    expect(parseProbeLine(line({ tpName: 'Pare-feu é' }))).toBeNull();
    expect(parseProbeLine(line({ rules: [{ act: 'Maybe', prof: 'Private' }] }))).toBeNull();
    expect(parseProbeLine(line({ rules: [{ act: 'Allow', prof: 'Private, Moon' }] }))).toBeNull();
    expect(parseProbeLine(line({ addr: [{ ip: '999.1.1.1', cat: 1 }] }))).toBeNull();
    expect(parseProbeLine(line({ prof: { Domain: on, Private: on } }))).toBeNull();
    // Every rule says whether it reaches the tailnet range.
    expect(parseProbeLine(line({ rules: [{ act: 'Allow', prof: 'Private' }] }).replace(',"tn":0', ''))).toBeNull();
  });

  it('"Any" profile means all three', () => {
    expect(facts({ rules: [{ act: 'Allow', prof: 'Any' }] }).rules[0].profiles).toEqual(['Domain', 'Private', 'Public']);
  });
});

describe('assessInbound — one verdict per case', () => {
  it('covered: our Allow on Private', () => {
    expect(verdict(facts({ rules: [OURS_ALLOW, OURS_BLOCK] }))).toBe('covered');
  });

  it('covered-by-prompt: an earlier prompt Allow on Private, any port', () => {
    expect(verdict(facts({ rules: [PROMPT_ALLOW_ANY] }))).toBe('covered-by-prompt');
  });

  it('not-covered: nothing, a rule for another port, or UDP only', () => {
    expect(verdict(facts())).toBe('not-covered');
    expect(verdict(facts({ rules: [{ act: 'Allow', prof: 'Private', hit: 0 }] }))).toBe('not-covered');
    expect(verdict(facts({ rules: [{ act: 'Allow', prof: 'Private', proto: 'UDP' }] }))).toBe('not-covered');
    // Public-only prompt Allow does not cover a Private network.
    expect(verdict(facts({ rules: [{ act: 'Allow', prof: 'Public', anyPort: 1 }] }))).toBe('not-covered');
  });

  it('stale-after-update: the record names an older exe and nothing covers the current one', () => {
    expect(verdict(facts(), OLD_EXE)).toBe('stale-after-update');
    // Same exe recorded but the rule is gone (removed in wf.msc): not stale, just not covered.
    expect(verdict(facts(), EXE)).toBe('not-covered');
    expect(verdict(facts({ rules: [OURS_ALLOW] }), OLD_EXE)).toBe('covered');
  });

  it('another install sharing the data folder is not "updated": its record has another rule ID base', () => {
    const other = { exe: 'D:\\portable\\wmux\\wmux.exe', id: 'wmux-a2a-0badf00d' };
    expect(assessInbound(facts(), ctx({ recorded: other })).verdict).toBe('not-covered');
    expect(assessInbound(facts(), ctx({ recorded: { ...other, id: BASE } })).verdict).toBe('stale-after-update');
  });

  it('tailnet: our Allow made before a tailnet address existed (LocalSubnet only) no longer covers', () => {
    const tailnetAddr = { addr: [{ ip: '192.168.1.10', cat: 1 }, { ip: '100.79.244.107', cat: 1 }] };
    expect(verdict(facts({ ...tailnetAddr, rules: [OURS_ALLOW, OURS_BLOCK] }), null, { tailnet: true })).toBe('not-covered');
    expect(verdict(facts({ ...tailnetAddr, rules: [{ ...OURS_ALLOW, tn: 1 }, OURS_BLOCK] }), null, { tailnet: true })).toBe('covered');
    // Updated since: the Fix it offers is the update's.
    expect(verdict(facts({ ...tailnetAddr, rules: [OURS_ALLOW] }), OLD_EXE, { tailnet: true })).toBe('stale-after-update');
    // No tailnet address offered: LocalSubnet is enough.
    expect(verdict(facts({ rules: [OURS_ALLOW] }), null, { tailnet: false })).toBe('covered');
  });

  it('blocked-by-rule: a Block for this exe beats every Allow; ours and legacy Blocks do not count', () => {
    expect(verdict(facts({ rules: [OURS_ALLOW, { act: 'Block', prof: 'Private, Public' }] }))).toBe('blocked-by-rule');
    expect(verdict(facts({ rules: [OURS_ALLOW, OURS_BLOCK] }))).toBe('covered');
    expect(verdict(facts({ rules: [{ act: 'Block', prof: 'Public, Domain', legacy: 1 }] }))).toBe('not-covered');
    // A Block on a profile no address uses is not in the way.
    expect(verdict(facts({ rules: [OURS_ALLOW, { act: 'Block', prof: 'Domain' }] }))).toBe('covered');
  });

  it('public-network: every real address is Public (or has no profile); vEthernet is ignored', () => {
    expect(verdict(facts({ addr: [{ ip: '192.168.45.28', cat: 0 }] }))).toBe('public-network');
    expect(verdict(facts({ addr: [{ ip: '192.168.45.28', cat: -1 }] }))).toBe('public-network');
    const withHyperV = markVirtual(
      facts({ addr: [{ ip: '192.168.45.28', cat: 0 }, { ip: '172.17.48.1', cat: 1 }] }),
      (ip) => (ip === '172.17.48.1' ? 'vEthernet (WSL (Hyper-V firewall))' : 'Wi-Fi'),
    );
    expect(verdict(withHyperV)).toBe('public-network');
  });

  it('mixed Private (Tailscale) and Public (Wi-Fi): judged on the Private one, both lists returned', () => {
    const a = assessInbound(facts({ addr: [{ ip: '100.79.244.107', cat: 1 }, { ip: '192.168.45.28', cat: 0 }], rules: [OURS_ALLOW] }), ctx());
    expect(a.verdict).toBe('covered');
    expect(a.okIps).toEqual(['100.79.244.107']);
    expect(a.publicIps).toEqual(['192.168.45.28']);
  });

  it('mixed Private + Public: a Public-only Block or profile switch does not hide the Private verdict', () => {
    const mixed = { addr: [{ ip: '192.168.1.5', cat: 1 }, { ip: '10.8.0.2', cat: 0 }] };
    // A Block the Windows prompt made when Cancel was pressed on a public network.
    const promptPublicBlock: RawRule = { act: 'Block', prof: 'Public' };
    expect(verdict(facts({ ...mixed, rules: [OURS_ALLOW, OURS_BLOCK, promptPublicBlock] }))).toBe('covered');
    expect(verdict(facts({ ...mixed, rules: [promptPublicBlock] }))).toBe('not-covered');
    // "Block all incoming connections" ticked for Public only.
    expect(verdict(facts({ ...mixed, rules: [OURS_ALLOW], prof: { Domain: on, Private: on, Public: { ...on, inb: 0 } } }))).toBe('covered');
    // Local rules ignored on Public only (a policy for public networks).
    expect(verdict(facts({ ...mixed, rules: [OURS_ALLOW], prof: { Domain: on, Private: on, Public: { ...on, loc: 0 } } }))).toBe('covered');
    // The Private side's own switches still decide.
    expect(verdict(facts({ ...mixed, rules: [OURS_ALLOW], prof: { Domain: on, Private: { ...on, inb: 0 }, Public: on } }))).toBe('inbound-blocked-all');
    expect(verdict(facts({ ...mixed, rules: [OURS_ALLOW, { act: 'Block', prof: 'Private' }] }))).toBe('blocked-by-rule');
    // Firewall off on Private, on for Public: the Private side is open.
    expect(verdict(facts({ ...mixed, prof: { Domain: on, Private: { ...on, en: 0 }, Public: on } }))).toBe('firewall-off');
    // The Public side is still told apart.
    const a = assessInbound(facts({ ...mixed, rules: [OURS_ALLOW, promptPublicBlock] }), ctx());
    expect(a.publicIps).toEqual(['10.8.0.2']);
  });

  it('every address Public: the Public profile decides', () => {
    const pub = { addr: [{ ip: '10.8.0.2', cat: 0 }] };
    expect(verdict(facts({ ...pub, prof: { Domain: on, Private: on, Public: { ...on, inb: 0 } } }))).toBe('inbound-blocked-all');
    expect(verdict(facts({ ...pub, prof: { Domain: on, Private: on, Public: { ...on, loc: 0 } } }))).toBe('policy-managed');
    expect(verdict(facts({ ...pub, rules: [{ act: 'Block', prof: 'Public' }] }))).toBe('blocked-by-rule');
    expect(verdict(facts(pub))).toBe('public-network');
  });

  it('domain-network: Domain only is explained unless something already allows it there', () => {
    expect(verdict(facts({ addr: [{ ip: '10.1.2.3', cat: 2 }] }))).toBe('domain-network');
    expect(verdict(facts({ addr: [{ ip: '10.1.2.3', cat: 2 }], rules: [{ act: 'Allow', prof: 'Domain, Private' }] }))).toBe('covered-by-prompt');
  });

  it('policy-managed, inbound-blocked-all and firewall-off read the profiles in use', () => {
    expect(verdict(facts({ prof: { Domain: on, Private: { ...on, loc: 0 }, Public: on } }))).toBe('policy-managed');
    expect(verdict(facts({ prof: { Domain: on, Private: { ...on, inb: 0 }, Public: on } }))).toBe('inbound-blocked-all');
    expect(verdict(facts({ prof: { Domain: on, Private: { ...on, en: 0 }, Public: on } }))).toBe('firewall-off');
    // A profile no address uses does not count.
    expect(verdict(facts({ prof: { Domain: { ...on, loc: 0 }, Private: on, Public: { ...on, inb: 0 } } }))).toBe('not-covered');
  });

  it('third-party wins over everything the probe could read', () => {
    expect(verdict(facts({ tp: 1, prof: { Domain: on, Private: { ...on, loc: 0 }, Public: on } }))).toBe('third-party');
  });

  it('precedence: policy-managed > inbound-blocked-all > firewall-off > blocked-by-rule > public-network', () => {
    expect(verdict(facts({ prof: { Domain: on, Private: { en: 0, inb: 0, loc: 0 }, Public: on } }))).toBe('policy-managed');
    expect(verdict(facts({ prof: { Domain: on, Private: { en: 0, inb: 0, loc: 1 }, Public: on } }))).toBe('inbound-blocked-all');
    expect(verdict(facts({ addr: [{ ip: '192.168.45.28', cat: 0 }], rules: [{ act: 'Block', prof: 'Public' }] }))).toBe('blocked-by-rule');
  });

  it('exposedPublic: a local prompt Allow on Public (any port or this one); not ours, not GPO', () => {
    const a = (rules: RawRule[]) => assessInbound(facts({ rules }), ctx());
    expect(a([PROMPT_ALLOW_ANY]).exposedPublic).toBe(true);
    expect(a([{ act: 'Allow', prof: 'Public' }]).exposedPublic).toBe(true);
    expect(a([{ act: 'Allow', prof: 'Public', hit: 0 }]).exposedPublic).toBe(false);
    expect(a([{ act: 'Allow', prof: 'Public', src: 'GroupPolicy' }]).exposedPublic).toBe(false);
    expect(a([{ act: 'Allow', prof: 'Private' }]).exposedPublic).toBe(false);
    expect(a([PROMPT_ALLOW_ANY, OURS_BLOCK]).publicBlocked).toBe(true);
    expect(a([PROMPT_ALLOW_ANY]).publicBlocked).toBe(false);
  });

  it('legacy LanLink rules are flagged and never count as cover', () => {
    const a = assessInbound(facts({ legacy: 1, rules: [{ act: 'Allow', prof: 'Private', legacy: 1 }] }), ctx());
    expect(a.legacyLanLink).toBe(true);
    expect(a.verdict).toBe('not-covered');
  });
});

describe('pickVerdict', () => {
  it('follows VERDICT_PRECEDENCE exactly', () => {
    for (let i = 0; i < VERDICT_PRECEDENCE.length; i += 1) {
      expect(pickVerdict(VERDICT_PRECEDENCE.slice(i))).toBe(VERDICT_PRECEDENCE[i]);
    }
    expect(VERDICT_PRECEDENCE).toEqual([
      'unknown', 'third-party', 'policy-managed', 'inbound-blocked-all', 'firewall-off', 'blocked-by-rule',
      'public-network', 'domain-network', 'stale-after-update', 'not-covered', 'covered-by-prompt', 'covered',
    ]);
  });
});

describe('macOS (unverified on a Mac)', () => {
  it('reads socketfilterfw sentences', () => {
    expect(parseMacFirewall('Firewall is enabled. (State = 1)', 'Firewall has block all state set to disabled.', 'The application /Applications/wmux.app is permitted'))
      .toEqual({ enabled: true, blockAll: false, app: 'permitted' });
    expect(assessMac(parseMacFirewall('Firewall is disabled. (State = 0)', '', ''))).toBe('firewall-off');
    expect(assessMac(parseMacFirewall('(State = 1)', 'block all state set to enabled', ''))).toBe('inbound-blocked-all');
    expect(assessMac(parseMacFirewall('(State = 1)', 'disabled', 'The application x is blocked'))).toBe('not-covered');
    expect(assessMac(parseMacFirewall('(State = 1)', 'disabled', 'x is not part of the firewall'))).toBe('not-covered');
    expect(assessMac(parseMacFirewall('?', '?', '?'))).toBe('unknown');
  });
});

function status(over: Partial<InboundStatus> = {}): InboundStatus {
  return {
    ...inapplicableStatus('a2a', 'win32', EXE, 0),
    applicable: true,
    port: 45660,
    verdict: 'not-covered',
    ruleIds: { allow: 'wmux-a2a-1a2b3c4d-allow', pubblock: 'wmux-a2a-1a2b3c4d-pubblock' },
    ...over,
  };
}

describe('firewallOffer', () => {
  it('fixable verdicts offer the Fix, unless refused (then Copy details)', () => {
    expect(firewallOffer(status()).actions).toEqual(['fix']);
    expect(firewallOffer(status({ verdict: 'stale-after-update' })).sentence?.key).toBe('net.fw.staleAfterUpdate');
    expect(firewallOffer(status({ refusal: 'node-daemon' }))).toEqual({ notice: true, sentence: { key: 'net.fw.nodeDaemon', vars: {} }, actions: ['copyDetails'] });
    expect(firewallOffer(status({ refusal: 'not-wmux-exe' })).actions).toEqual(['copyDetails']);
  });

  it('explain-only verdicts never offer the Fix', () => {
    for (const v of ['blocked-by-rule', 'public-network', 'domain-network', 'policy-managed', 'inbound-blocked-all', 'third-party', 'unknown'] as const) {
      const o = firewallOffer(status({ verdict: v }));
      expect(o.notice).toBe(true);
      expect(o.actions).not.toContain('fix');
    }
    expect(firewallOffer(status({ verdict: 'blocked-by-rule' })).actions).toEqual(['openFirewall']);
    expect(firewallOffer(status({ verdict: 'public-network', publicNetworks: ['Wi-Fi'] })).sentence).toEqual({ key: 'net.fw.publicNetwork', vars: { network: 'Wi-Fi' } });
    expect(firewallOffer(status({ verdict: 'unknown' })).actions).toEqual(['check']);
  });

  it('covered and firewall-off are muted lines; inapplicable draws nothing', () => {
    expect(firewallOffer(status({ verdict: 'covered' }))).toEqual({ notice: false, sentence: { key: 'net.fw.allowed', vars: { port: 45660 } }, actions: [] });
    expect(firewallOffer(status({ verdict: 'firewall-off' }))).toEqual({ notice: false, sentence: { key: 'net.fw.off', vars: {} }, actions: [] });
    expect(firewallOffer(inapplicableStatus('a2a', 'win32', EXE, 0)).sentence).toBeNull();
  });

  it('third party names the product only when known', () => {
    expect(firewallOffer(status({ verdict: 'third-party', thirdPartyName: 'ESET Firewall' })).sentence).toEqual({ key: 'net.fw.thirdParty', vars: { product: 'ESET Firewall', port: 45660 } });
    expect(firewallOffer(status({ verdict: 'third-party' })).sentence?.key).toBe('net.fw.thirdPartyUnnamed');
  });

  it('partlyPublicSentence only when both kinds of network are in use', () => {
    expect(partlyPublicSentence(status({ okNetworks: ['Tailscale'], publicNetworks: ['Wi-Fi'] }))).toEqual({ key: 'net.fw.partlyPublic', vars: { ok: 'Tailscale', network: 'Wi-Fi' } });
    expect(partlyPublicSentence(status({ okNetworks: ['Tailscale'] }))).toBeNull();
  });

  it('details text names the program, port and rule names', () => {
    const text = firewallDetailsText(status());
    expect(text).toContain(EXE);
    expect(text).toContain('TCP 45660');
    expect(text).toContain('wmux-a2a-1a2b3c4d-allow');
  });
});

describe('elevationOutcome', () => {
  it('a declined prompt (FALSE + 1223) is cancelled', () => {
    expect(elevationOutcome({ started: false, lastError: 1223 })).toEqual({ kind: 'cancelled' });
  });
  it('any other start failure keeps its Win32 code', () => {
    expect(elevationOutcome({ started: false, lastError: 5 })).toEqual({ kind: 'failed', stage: null, code: 5 });
  });
  it('exit codes 10/11/12 name the stage; 0 is ok; others keep the code', () => {
    expect(elevationOutcome({ started: true, exitCode: 0 })).toEqual({ kind: 'ok' });
    expect(elevationOutcome({ started: true, exitCode: 10 })).toEqual({ kind: 'failed', stage: 'cleanup', code: 10 });
    expect(elevationOutcome({ started: true, exitCode: 11 })).toEqual({ kind: 'failed', stage: 'allow', code: 11 });
    expect(elevationOutcome({ started: true, exitCode: 12 })).toEqual({ kind: 'failed', stage: 'pubblock', code: 12 });
    expect(elevationOutcome({ started: true, exitCode: 1 })).toEqual({ kind: 'failed', stage: null, code: 1 });
    expect(elevationOutcome({ started: true, exitCode: null })).toEqual({ kind: 'failed', stage: null, code: null });
  });
  it('failedError says a stage (an i18n key) or a code, never stderr', () => {
    expect(failedError({ kind: 'failed', stage: 'pubblock', code: 12 })).toEqual({ key: 'net.fw.stage.pubblock' });
    expect(failedError({ kind: 'failed', stage: null, code: 5 })).toEqual({ code: '5' });
    expect(failedError({ kind: 'failed', stage: null, code: null })).toEqual({ key: 'remotePage.unknown' });
  });
});

describe('elevationKind', () => {
  it('maps the token type to the prompt and its hint', () => {
    expect(elevationKind(3, false)).toBe('consent');
    expect(elevationKind(1, false)).toBe('credential');
    expect(elevationKind(2, false)).toBe('elevated');
    expect(elevationKind(3, true)).toBe('elevated');
    expect(elevationKind(null, null)).toBe('consent');
    expect(allowHintKey('consent')).toBe('net.fw.allowHintConsent');
    expect(allowHintKey('credential')).toBe('net.fw.allowHintCredential');
    expect(allowHintKey('elevated')).toBe('net.fw.allowHintElevated');
  });
});
