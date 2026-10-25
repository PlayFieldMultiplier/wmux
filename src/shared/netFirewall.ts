// === Can another PC reach this listener through the host firewall? ===
//
// The daemon runs a read-only probe (Windows: one PowerShell process, see
// netFirewallScripts.ts; macOS: socketfilterfw) when a person looks: the
// Remote page opening, Check firewall, after a Fix, a port change or a
// listener restart. Never on a poll. This module holds what the renderer,
// main and the daemon share: the verdict vocabulary, the probe line's parser,
// the verdict rules and what each verdict offers.
//
// What the host can know is limited. A rule that covers the port is not proof
// that packets arrive (AP isolation, a router, another filter), so nothing
// here ever says "fixed"; the copy says "allowed" and asks the other PC to
// connect again.
//
// Pure, no imports: the renderer bundles it.

export const FIREWALL_LISTENERS = ['a2a', 'web', 'lanlink'] as const;
export type FirewallListener = (typeof FIREWALL_LISTENERS)[number];

export function isFirewallListener(v: unknown): v is FirewallListener {
  return typeof v === 'string' && (FIREWALL_LISTENERS as readonly string[]).includes(v);
}

/**
 * The firewall's answer for one listener. Several can hold at once; the
 * probe reports the first in VERDICT_PRECEDENCE.
 *
 * - `covered`: our Allow rule exists for this program and port on Private.
 * - `covered-by-prompt`: no rule of ours, but an Allow from an earlier
 *   Windows prompt (or an admin) covers the port on Private.
 * - `not-covered`: nothing allows this program and port on Private.
 * - `stale-after-update`: our rule was made for an older wmux.exe path
 *   (firewall-rules.json says so) and nothing covers the current one.
 * - `blocked-by-rule`: a Block rule for this program covers the port on a
 *   network the listener uses. A Block beats every Allow.
 * - `public-network`: every address the listener offers is on a network
 *   Windows marks Public (virtual Hyper-V adapters are ignored).
 * - `domain-network`: the addresses are on a Domain (work) network. Fix
 *   adds Private rules only, so this is explained, not ruled.
 * - `policy-managed`: AllowLocalFirewallRules is off in the effective policy.
 * - `inbound-blocked-all`: AllowInboundRules is off ("block all incoming
 *   connections"), or macOS's "Block all incoming connections".
 * - `third-party`: another firewall product is registered with Windows.
 * - `firewall-off`: the firewall is off for the networks in use.
 * - `unknown`: the probe failed, timed out or answered something unreadable.
 */
export type InboundVerdict =
  | 'covered'
  | 'covered-by-prompt'
  | 'not-covered'
  | 'stale-after-update'
  | 'blocked-by-rule'
  | 'public-network'
  | 'domain-network'
  | 'policy-managed'
  | 'inbound-blocked-all'
  | 'third-party'
  | 'firewall-off'
  | 'unknown';

/** Highest first: when several verdicts hold, the earliest one is reported. */
export const VERDICT_PRECEDENCE: readonly InboundVerdict[] = [
  'unknown',
  'third-party',
  'policy-managed',
  'inbound-blocked-all',
  'firewall-off',
  'blocked-by-rule',
  'public-network',
  'domain-network',
  'stale-after-update',
  'not-covered',
  'covered-by-prompt',
  'covered',
];

/** The highest-precedence verdict among `held`; `covered` when none is given. */
export function pickVerdict(held: Iterable<InboundVerdict>): InboundVerdict {
  const set = new Set(held);
  return VERDICT_PRECEDENCE.find((v) => set.has(v)) ?? 'covered';
}

/** Why the Fix is not offered even though the verdict is fixable. Copy details only. */
export type FixRefusal =
  /** The daemon runs under node.exe: a program rule would open the port for every Node script. */
  | 'node-daemon'
  /** The daemon's program is not wmux.exe (a development build under electron.exe). */
  | 'not-wmux-exe'
  /** The daemon's program path does not exist, or is not an absolute drive path. */
  | 'exe-missing'
  /**
   * The program is on a network, SUBST or removable drive. The elevated
   * session may not see a per-logon drive letter, and the firewall service
   * cannot match a rule to it.
   */
  | 'not-local-drive'
  /**
   * The path holds a character the elevated script refuses (`$`, a backtick,
   * a double quote, a line break), or a wildcard (`[`, `]`, `*`, `?`), which
   * the firewall's by-program query would read as a pattern.
   */
  | 'bad-path'
  /** macOS and Windows only; elsewhere the static hint stays. */
  | 'unsupported-platform';

export type FirewallPlatform = 'win32' | 'darwin' | 'other';

/** The result of `net.inboundStatus`. */
export interface InboundStatus {
  listener: FirewallListener;
  platform: FirewallPlatform;
  /**
   * False while there is nothing to check: the listener is off or failed to
   * bind, or (web) it serves loopback only. The verdict is then `unknown` and
   * the UI draws nothing for it.
   */
  applicable: boolean;
  port: number | null;
  verdict: InboundVerdict;
  /** An Allow from an earlier Windows prompt lets public networks reach wmux.exe (any port, or this one). */
  exposedPublic: boolean;
  /** Our Public Block rule exists for this port, so that Allow no longer reaches it. */
  publicBlocked: boolean;
  /** Rules from older wmux versions (`wmux LanLink (Private)` / `(Public deny)`) exist; a Fix removes ours. */
  legacyLanLink: boolean;
  /** Adapter names of the Private (or Domain) networks the listener is offered on. */
  okNetworks: string[];
  /** Adapter names of the Public networks the listener is offered on. */
  publicNetworks: string[];
  /** A registered third-party firewall's name, when it is printable ASCII. */
  thirdPartyName: string | null;
  /** The daemon's program path the rules name. */
  exe: string;
  refusal: FixRefusal | null;
  /** Our two rule IDs for this listener and install (Windows), null elsewhere. */
  ruleIds: { allow: string; pubblock: string } | null;
  /** Epoch ms of the probe. */
  checkedAt: number;
  /** Epoch ms of the last connection from another machine since the listener started, or null. */
  inboundSeenAt: number | null;
}

/** An `InboundStatus` with nothing to check (listener off, loopback only, not this OS). */
export function inapplicableStatus(
  listener: FirewallListener,
  platform: FirewallPlatform,
  exe: string,
  now: number,
  refusal: FixRefusal | null = platform === 'other' ? 'unsupported-platform' : null,
): InboundStatus {
  return {
    listener,
    platform,
    applicable: false,
    port: null,
    verdict: 'unknown',
    exposedPublic: false,
    publicBlocked: false,
    legacyLanLink: false,
    okNetworks: [],
    publicNetworks: [],
    thirdPartyName: null,
    exe,
    refusal,
    ruleIds: null,
    checkedAt: now,
    inboundSeenAt: null,
  };
}

// ── The Windows probe line ───────────────────────────────────────────────────

export type ProfileName = 'Domain' | 'Private' | 'Public';
const PROFILE_NAMES: readonly ProfileName[] = ['Domain', 'Private', 'Public'];

export interface ProfileFacts {
  enabled: boolean;
  allowInboundRules: boolean;
  allowLocalRules: boolean;
}

export type AddressCategory = ProfileName | 'None';

export interface ProbeAddress {
  ip: string;
  category: AddressCategory;
  /**
   * A Hyper-V virtual switch adapter (WSL, containers): never where another
   * PC connects. Not part of the probe line; the daemon sets it from the
   * adapter's name (markVirtual).
   */
  virtual: boolean;
}

export interface ProbeRule {
  action: 'Allow' | 'Block';
  profiles: ProfileName[];
  /** Matches TCP (protocol TCP or Any). */
  tcp: boolean;
  /** The local port filter includes this listener's port (or is Any). */
  coversPort: boolean;
  /** The local port filter is Any. */
  anyPort: boolean;
  /** One of our two rule IDs. */
  ours: boolean;
  /** A `wmux LanLink (…)` rule from an older wmux. */
  legacy: boolean;
  /** Stored locally (prompt-created or added by hand), not by Group Policy or MDM. */
  local: boolean;
  /** One of ours whose remote addresses include the tailnet range (100.64.0.0/10) or Any. */
  tailnet: boolean;
}

export interface ProbeFacts {
  profiles: Record<ProfileName, ProfileFacts>;
  addresses: ProbeAddress[];
  rules: ProbeRule[];
  legacyLanLink: boolean;
  thirdParty: boolean;
  thirdPartyName: string | null;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(v: unknown): v is string {
  return typeof v === 'string' && IPV4_RE.test(v);
}

function bit(v: unknown): boolean | null {
  return v === 1 ? true : v === 0 ? false : null;
}

/** `"Private, Public"` / `"Any"` → profile names; null when unreadable. */
export function parseProfileList(v: unknown): ProfileName[] | null {
  if (typeof v !== 'string') return null;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0] === 'Any') return [...PROFILE_NAMES];
  const out: ProfileName[] = [];
  for (const p of parts) {
    if (!(PROFILE_NAMES as readonly string[]).includes(p)) return null;
    out.push(p as ProfileName);
  }
  return out;
}

const CATEGORY_CODES: Record<number, AddressCategory> = { 0: 'Public', 1: 'Private', 2: 'Domain', [-1]: 'None' };

/**
 * Parse the probe's one JSON line. The output contract is printable ASCII
 * only (paths and adapter names never cross the pipe, so a console codepage
 * cannot garble them); any other byte, a second JSON line, a missing field
 * or a wrong type gives null, which the caller reports as `unknown`.
 */
export function parseProbeLine(stdout: string): ProbeFacts | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (lines.length !== 1) return null;
  const line = lines[0];
  if (!/^[\x20-\x7e]+$/.test(line)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1) return null;

  const prof = o['prof'];
  if (!prof || typeof prof !== 'object') return null;
  const profiles = {} as Record<ProfileName, ProfileFacts>;
  for (const name of PROFILE_NAMES) {
    const p = (prof as Record<string, unknown>)[name];
    if (!p || typeof p !== 'object') return null;
    const pr = p as Record<string, unknown>;
    const enabled = bit(pr['en']);
    const allowInboundRules = bit(pr['inb']);
    const allowLocalRules = bit(pr['loc']);
    if (enabled === null || allowInboundRules === null || allowLocalRules === null) return null;
    profiles[name] = { enabled, allowInboundRules, allowLocalRules };
  }

  const addresses: ProbeAddress[] = [];
  const addr = o['addr'] ?? [];
  if (!Array.isArray(addr)) return null;
  for (const a of addr) {
    if (!a || typeof a !== 'object') return null;
    const ar = a as Record<string, unknown>;
    const category = typeof ar['cat'] === 'number' ? CATEGORY_CODES[ar['cat']] : undefined;
    if (!isIpv4(ar['ip']) || !category) return null;
    addresses.push({ ip: ar['ip'], category, virtual: false });
  }

  const rules: ProbeRule[] = [];
  const rs = o['rules'] ?? [];
  if (!Array.isArray(rs)) return null;
  for (const r of rs) {
    if (!r || typeof r !== 'object') return null;
    const rr = r as Record<string, unknown>;
    const action = rr['act'];
    const profilesOf = parseProfileList(rr['prof']);
    const coversPort = bit(rr['hit']);
    const anyPort = bit(rr['anyPort']);
    const ours = bit(rr['ours']);
    const legacy = bit(rr['legacy']);
    const tailnet = bit(rr['tn']);
    if ((action !== 'Allow' && action !== 'Block') || !profilesOf || coversPort === null || anyPort === null || ours === null || legacy === null || tailnet === null) {
      return null;
    }
    if (typeof rr['proto'] !== 'string' || typeof rr['src'] !== 'string') return null;
    const proto = rr['proto'].toUpperCase();
    rules.push({
      action,
      profiles: profilesOf,
      tcp: proto === 'TCP' || proto === 'ANY' || proto === '6',
      coversPort,
      anyPort,
      ours,
      legacy,
      local: rr['src'] === 'Local',
      tailnet,
    });
  }

  const legacyLanLink = bit(o['legacy']);
  const thirdParty = bit(o['tp']);
  if (legacyLanLink === null || thirdParty === null) return null;
  const tpName = o['tpName'];
  if (tpName !== null && tpName !== undefined && typeof tpName !== 'string') return null;
  return {
    profiles,
    addresses,
    rules,
    legacyLanLink,
    thirdParty,
    thirdPartyName: typeof tpName === 'string' && tpName ? tpName : null,
  };
}

/** Hyper-V names its virtual switch adapters `vEthernet (…)` (WSL, Default Switch, containers). */
export const HYPERV_ADAPTER_RE = /^vEthernet\b/i;

/** Mark the addresses that sit on a Hyper-V virtual adapter, by the adapter name Node reports. */
export function markVirtual(facts: ProbeFacts, adapterOf: (ip: string) => string | null): ProbeFacts {
  return {
    ...facts,
    addresses: facts.addresses.map((a) => ({ ...a, virtual: HYPERV_ADAPTER_RE.test(adapterOf(a.ip) ?? '') })),
  };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface AssessContext {
  /**
   * What firewall-rules.json last recorded a confirmed rule for on this
   * listener, or null. The same rule ID base (same install root, instance
   * and user) with a different program path means wmux was updated since
   * (Squirrel moves the exe to a new app-X.Y.Z). Another install sharing the
   * data folder has another base and is not "updated".
   */
  recorded: { exe: string; id: string } | null;
  /** The current program path. */
  exe: string;
  /** This install's rule ID base for the listener (`wmux-a2a-1a2b3c4d`). */
  ruleBase: string;
  /** The listener offers a tailnet address: our Allow must include 100.64.0.0/10 to cover it. */
  tailnet: boolean;
}

export interface InboundAssessment {
  verdict: InboundVerdict;
  exposedPublic: boolean;
  publicBlocked: boolean;
  legacyLanLink: boolean;
  /** IPs on Private or Domain networks, and on Public ones (virtual adapters left out). */
  okIps: string[];
  publicIps: string[];
  thirdPartyName: string | null;
}

/**
 * The verdict for one listener from the probe's facts. Our own rules and the
 * older LanLink rules are never "someone else's Block" (our Public Block is
 * deliberate, and a Fix removes the legacy ones); every other rule counts
 * whatever made it, since the firewall applies it either way.
 */
export function assessInbound(facts: ProbeFacts, ctx: AssessContext): InboundAssessment {
  // An address with no connection profile is filtered as Public by Windows.
  const real = facts.addresses.filter((a) => !a.virtual);
  const catOf = (a: ProbeAddress): ProfileName => (a.category === 'None' ? 'Public' : a.category);
  const okIps = real.filter((a) => catOf(a) !== 'Public').map((a) => a.ip);
  const publicIps = real.filter((a) => catOf(a) === 'Public').map((a) => a.ip);
  const inUse = new Set<ProfileName>(real.map(catOf));
  // Nothing advertised (no LAN address yet): the Fix's network is the one to judge.
  if (inUse.size === 0) inUse.add('Private');
  const used = [...inUse];

  const tcpForPort = facts.rules.filter((r) => r.tcp && r.coversPort);
  const allowsOn = (p: ProfileName, pred: (r: ProbeRule) => boolean): boolean =>
    tcpForPort.some((r) => r.action === 'Allow' && !r.legacy && r.profiles.includes(p) && pred(r));

  // On a mixed Private + Public PC the listener works over the Private side,
  // and the Public side is said separately (partlyPublic). So the profile
  // switches and Blocks are judged on the networks that can work; only when
  // every address is Public do the Public profile's switches decide.
  const okCats = used.filter((p) => p !== 'Public');
  const judged = okCats.length > 0 ? okCats : used;

  const held = new Set<InboundVerdict>();
  if (facts.thirdParty) held.add('third-party');
  if (judged.some((p) => !facts.profiles[p].allowLocalRules)) held.add('policy-managed');
  if (judged.some((p) => !facts.profiles[p].allowInboundRules)) held.add('inbound-blocked-all');
  if (judged.every((p) => !facts.profiles[p].enabled)) held.add('firewall-off');
  const blocking = tcpForPort.filter((r) => r.action === 'Block' && !r.ours && !r.legacy);
  if (blocking.some((r) => judged.some((p) => r.profiles.includes(p) && facts.profiles[p].enabled))) held.add('blocked-by-rule');

  const stale =
    ctx.recorded !== null && ctx.recorded.id === ctx.ruleBase && ctx.recorded.exe.toLowerCase() !== ctx.exe.toLowerCase();
  if (okCats.length === 0) {
    held.add('public-network');
  } else if (okCats.includes('Private')) {
    // Our Allow made before a tailnet address existed is LocalSubnet only, and
    // CGNAT is not LocalSubnet: a Fix makes it again with the tailnet range.
    if (allowsOn('Private', (r) => r.ours && (!ctx.tailnet || r.tailnet))) held.add('covered');
    else if (allowsOn('Private', (r) => !r.ours)) held.add('covered-by-prompt');
    else if (stale) held.add('stale-after-update');
    else held.add('not-covered');
  } else {
    // Domain only: our rules are Private only, so only an existing Allow helps.
    if (allowsOn('Domain', () => true)) held.add('covered-by-prompt');
    else held.add('domain-network');
  }

  const exposedPublic = facts.rules.some(
    (r) => r.action === 'Allow' && r.local && !r.ours && !r.legacy && r.tcp && r.profiles.includes('Public') && (r.anyPort || r.coversPort),
  );
  const publicBlocked = tcpForPort.some((r) => r.action === 'Block' && r.ours && r.profiles.includes('Public'));
  return {
    verdict: pickVerdict(held),
    exposedPublic,
    publicBlocked,
    legacyLanLink: facts.legacyLanLink,
    okIps,
    publicIps,
    thirdPartyName: facts.thirdParty ? facts.thirdPartyName : null,
  };
}

// ── macOS application firewall (verify on Mac) ───────────────────────────────

export interface MacFirewallFacts {
  /** `socketfilterfw --getglobalstate`. */
  enabled: boolean | null;
  /** `--getblockall`. */
  blockAll: boolean | null;
  /** `--getappblocked <path>`. */
  app: 'permitted' | 'blocked' | 'not-listed' | null;
}

/**
 * Read socketfilterfw's English sentences ("Firewall is enabled. (State = 1)",
 * "Block all INCOMING connections is disabled", "The application … is
 * permitted"). Unverified on a Mac: the wording is from Apple's man page and
 * public transcripts; anything else reads as null.
 */
export function parseMacFirewall(globalState: string, blockAll: string, appBlocked: string): MacFirewallFacts {
  let enabled: boolean | null = null;
  const state = /\(State = (\d)\)/.exec(globalState);
  if (state) enabled = state[1] !== '0';
  else if (/\bis enabled\b/i.test(globalState)) enabled = true;
  else if (/\bis disabled\b/i.test(globalState)) enabled = false;
  const b = /\b(enabled|disabled)\b/i.exec(blockAll);
  let app: MacFirewallFacts['app'] = null;
  if (/\bis permitted\b|\ballowed\b/i.test(appBlocked)) app = 'permitted';
  else if (/\bis blocked\b/i.test(appBlocked)) app = 'blocked';
  else if (/not part of the firewall/i.test(appBlocked)) app = 'not-listed';
  return { enabled, blockAll: b ? b[1].toLowerCase() === 'enabled' : null, app };
}

export function assessMac(facts: MacFirewallFacts): InboundVerdict {
  if (facts.enabled === null) return 'unknown';
  if (!facts.enabled) return 'firewall-off';
  if (facts.blockAll === null) return 'unknown';
  if (facts.blockAll) return 'inbound-blocked-all';
  if (facts.app === 'permitted') return 'covered';
  if (facts.app === 'blocked' || facts.app === 'not-listed') return 'not-covered';
  return 'unknown';
}

// ── What each verdict offers ─────────────────────────────────────────────────

export type FirewallAction = 'fix' | 'openFirewall' | 'openNetworkSettings' | 'copyDetails' | 'check';

export interface FirewallOffer {
  /** Draw a notice row (a warning). False: a muted line or nothing. */
  notice: boolean;
  /** The sentence: an i18n key and its values. Null: draw nothing. */
  sentence: { key: string; vars: Record<string, string | number> } | null;
  actions: FirewallAction[];
}

/** The listeners whose Fix Windows can perform (a program rule is meaningful). */
export function isFixableVerdict(v: InboundVerdict): boolean {
  return v === 'not-covered' || v === 'stale-after-update';
}

/**
 * What the UI says and offers for a status. One place, so every surface (the
 * Remote page, the invite tab, Settings › LAN, Share & pair) agrees.
 */
export function firewallOffer(s: InboundStatus): FirewallOffer {
  const none: FirewallOffer = { notice: false, sentence: null, actions: [] };
  if (!s.applicable || s.platform === 'other') return none;
  const port = s.port ?? 0;
  const mac = s.platform === 'darwin';
  switch (s.verdict) {
    case 'covered':
      return { notice: false, sentence: { key: mac ? 'net.fw.allowedMac' : 'net.fw.allowed', vars: { port } }, actions: [] };
    case 'covered-by-prompt':
      return { notice: false, sentence: { key: 'net.fw.allowedByPrompt', vars: {} }, actions: [] };
    case 'not-covered':
    case 'stale-after-update': {
      const key = s.verdict === 'stale-after-update' ? 'net.fw.staleAfterUpdate' : mac ? 'net.fw.notCoveredMac' : 'net.fw.notCovered';
      if (s.refusal === 'node-daemon') return { notice: true, sentence: { key: 'net.fw.nodeDaemon', vars: {} }, actions: ['copyDetails'] };
      if (s.refusal) return { notice: true, sentence: { key, vars: { port } }, actions: ['copyDetails'] };
      return { notice: true, sentence: { key, vars: { port } }, actions: ['fix'] };
    }
    case 'blocked-by-rule':
      return { notice: true, sentence: { key: 'net.fw.blockedByRule', vars: {} }, actions: ['openFirewall'] };
    case 'public-network': {
      const network = s.publicNetworks.join(', ') || '—';
      return { notice: true, sentence: { key: 'net.fw.publicNetwork', vars: { network } }, actions: ['openNetworkSettings'] };
    }
    case 'domain-network':
      return { notice: true, sentence: { key: 'net.fw.domainNetwork', vars: { port } }, actions: ['copyDetails'] };
    case 'policy-managed':
      return { notice: true, sentence: { key: 'net.fw.policyManaged', vars: { port } }, actions: ['copyDetails'] };
    case 'inbound-blocked-all':
      return {
        notice: true,
        sentence: { key: mac ? 'net.fw.macBlockAll' : 'net.fw.inboundBlockedAll', vars: {} },
        actions: ['copyDetails'],
      };
    case 'third-party':
      return s.thirdPartyName
        ? { notice: true, sentence: { key: 'net.fw.thirdParty', vars: { product: s.thirdPartyName, port } }, actions: ['copyDetails'] }
        : { notice: true, sentence: { key: 'net.fw.thirdPartyUnnamed', vars: { port } }, actions: ['copyDetails'] };
    case 'firewall-off':
      return { notice: false, sentence: { key: 'net.fw.off', vars: {} }, actions: [] };
    case 'unknown':
      // A refused program (a path the probe cannot query) will not read better on a second try.
      return { notice: true, sentence: { key: 'net.fw.unknown', vars: {} }, actions: s.refusal ? ['copyDetails'] : ['check'] };
  }
}

/**
 * The "works over X; not over Y (Public)" line, for a listener offered on
 * both kinds of network. Null when it is not mixed.
 */
export function partlyPublicSentence(s: InboundStatus): { key: string; vars: Record<string, string> } | null {
  if (!s.applicable || s.okNetworks.length === 0 || s.publicNetworks.length === 0) return null;
  return { key: 'net.fw.partlyPublic', vars: { ok: s.okNetworks.join(', '), network: s.publicNetworks.join(', ') } };
}

const LISTENER_NAMES: Record<FirewallListener, string> = { a2a: 'A2A', web: 'web', lanlink: 'LanLink' };

/** The plain-text details for an administrator or IT: what the rule would be and why. */
export function firewallDetailsText(s: InboundStatus): string {
  const port = s.port ?? 0;
  const lines = [
    `wmux ${LISTENER_NAMES[s.listener]} listener`,
    `Port: TCP ${port} (inbound)`,
    `Program: ${s.exe}`,
    `Firewall check: ${s.verdict}`,
  ];
  if (s.platform === 'win32') {
    lines.push(
      'Proposed rules:',
      `  Allow  inbound TCP ${port}, program above, profile Private, remote address LocalSubnet`,
      `  Block  inbound TCP ${port}, program above, profile Public`,
    );
    if (s.ruleIds) lines.push(`Rule names: ${s.ruleIds.allow}, ${s.ruleIds.pubblock} (group wmux)`);
  } else if (s.platform === 'darwin') {
    lines.push('Proposed change: allow incoming connections for the program above in the macOS firewall');
  }
  if (s.refusal) lines.push(`Not added by wmux: ${s.refusal}`);
  return lines.join('\n');
}

// ── After an elevated Fix or Remove ──────────────────────────────────────────

/** How the elevated run ended. The re-probe that follows decides what the UI says about the rule. */
export type ElevationOutcome =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; stage: 'cleanup' | 'allow' | 'pubblock' | null; code: number | null };

/** ERROR_CANCELLED: the person declined the Windows permission request. */
export const ERROR_CANCELLED = 1223;
/** The Fix script's exit code per stage. */
export const FIX_STAGE_EXIT = { cleanup: 10, allow: 11, pubblock: 12 } as const;

/**
 * Map what ShellExecuteExW and the child reported to an outcome. `started`
 * false: ShellExecuteExW returned FALSE, and `lastError` is GetLastError()
 * right after it (1223 is the declined prompt). Otherwise `exitCode` is the
 * child's exit code (null when it could not be read or the wait timed out).
 * No text is ever matched: an elevated child has no stderr to read.
 */
export function elevationOutcome(r: { started: boolean; lastError?: number | null; exitCode?: number | null }): ElevationOutcome {
  if (!r.started) {
    if (r.lastError === ERROR_CANCELLED) return { kind: 'cancelled' };
    return { kind: 'failed', stage: null, code: r.lastError ?? null };
  }
  switch (r.exitCode) {
    case 0:
      return { kind: 'ok' };
    case FIX_STAGE_EXIT.cleanup:
      return { kind: 'failed', stage: 'cleanup', code: r.exitCode };
    case FIX_STAGE_EXIT.allow:
      return { kind: 'failed', stage: 'allow', code: r.exitCode };
    case FIX_STAGE_EXIT.pubblock:
      return { kind: 'failed', stage: 'pubblock', code: r.exitCode };
    default:
      return { kind: 'failed', stage: null, code: r.exitCode ?? null };
  }
}

/** Which prompt the person will see: consent (Yes/No), credentials, or none (wmux is already elevated). */
export type ElevationKind = 'consent' | 'credential' | 'elevated';

/** TOKEN_ELEVATION_TYPE: 1 Default (no split token), 2 Full, 3 Limited. */
export function elevationKind(tokenType: number | null, selfElevated: boolean | null): ElevationKind {
  if (selfElevated === true || tokenType === 2) return 'elevated';
  // A standard user (or an admin with UAC off) has a Default token: Windows
  // asks for an administrator's password. Over-cautious for the UAC-off admin.
  if (tokenType === 1) return 'credential';
  return 'consent';
}

export function allowHintKey(kind: ElevationKind): string {
  return kind === 'elevated' ? 'net.fw.allowHintElevated' : kind === 'credential' ? 'net.fw.allowHintCredential' : 'net.fw.allowHintConsent';
}

/**
 * The `{error}` of net.fw.failed: the failed stage's i18n key, or a Win32/exit
 * code as is. Never stderr.
 */
export function failedError(o: Extract<ElevationOutcome, { kind: 'failed' }>): { key: string } | { code: string } {
  if (o.stage) return { key: `net.fw.stage.${o.stage}` };
  return o.code === null ? { key: 'remotePage.unknown' } : { code: String(o.code) };
}

/** The answer to a Fix or Remove: how the elevated run ended, and the fresh probe. */
export interface FirewallActionResult {
  outcome: ElevationOutcome | { kind: 'refused'; refusal: FixRefusal | 'changed' | 'busy' };
  status: InboundStatus | null;
}

/** `net:inboundStatus`'s answer to the renderer: the probe plus which prompt a Fix shows. */
export interface InboundStatusView extends InboundStatus {
  elevation: ElevationKind;
}
