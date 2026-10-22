import type { TailscaleProblem } from '../../../cli/tailscale';
import type { TailscaleCheckItem, TailscaleChecklist, TailscaleFix } from '../../../shared/web';
import { isTailnetIpv4, parseInvite } from '../../../shared/a2aRemote';
import { parseRemotePairInput } from '../../../shared/remotePairInput';
import { t } from '../../i18n';

// ─── Tailscale, as the Remote page and its connections see it ────────────────
//
// The checks themselves run in main (`web.tailscaleCheck`, one read-only
// `tailscale status --json`); this module only decides what a connection does
// with the answer. A connection is held back only when its address is surely
// a Tailscale one AND a check failed for a reason a person can fix:
//
//   *.ts.net name             always Tailscale's
//   100.64.0.0/10 address     Tailscale's only when its status lists it as a
//                             peer. Other overlays (and some LANs) use the
//                             same range, so any other such address is tried,
//                             and the Tailscale reason is added only if the
//                             connection then cannot reach the other PC.
//
// "Could not read the status", this PC being offline from Tailscale's control
// server (known peers still work), or a missing bridge never block: the
// connection then tries exactly as it did before.

const normalizeHost = (host: string): string => host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/** A MagicDNS name or an address in the tailnet range (100.64.0.0/10), which other overlays share. */
export function isTailnetHost(host: string): boolean {
  const h = normalizeHost(host);
  return isTailnetIpv4(h) || h.endsWith('.ts.net');
}

/** A MagicDNS name: only Tailscale hands these out. */
export function isTailnetName(host: string): boolean {
  return normalizeHost(host).endsWith('.ts.net');
}

/** The host of an origin or URL, or '' when it does not parse. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The tailnet host a pasted invite or pairing link connects to, when every
 * address it would try is on the tailnet; null otherwise. An invite that also
 * offers a LAN or company-DNS address is not held back: that address may well
 * work with Tailscale off.
 */
export function tailnetTargetOf(text: string): string | null {
  const invite = parseInvite(text);
  if (invite.ok) {
    const all = [invite.invite.host, ...(invite.invite.alt ?? [])];
    return all.every(isTailnetHost) ? invite.invite.host : null;
  }
  const parsed = parseRemotePairInput(text);
  if (parsed.kind === 'error') return null;
  const host = hostOfUrl(parsed.origin);
  return host && isTailnetHost(host) ? host : null;
}

/** The one failed check, if any (the checks after it are unchecked). */
export function failedCheck(list: TailscaleChecklist | null): TailscaleCheckItem | null {
  return list?.items.find((i) => i.state === 'fail') ?? null;
}

/**
 * The failure that can explain a connection not getting through: any failed
 * check except an unreadable status, which says nothing either way, and this
 * PC being offline from Tailscale's control server, which still carries
 * traffic to the peers it knows.
 */
export function blockingFailure(list: TailscaleChecklist | null): TailscaleCheckItem | null {
  const item = failedCheck(list);
  return item && item.reason !== 'unreadable' && item.reason !== 'offline' ? item : null;
}

export interface TailnetNotice {
  text: string;
  fix?: TailscaleFix;
}

export interface TailnetVerdict {
  /** Stop before connecting: the address is surely Tailscale's and Tailscale cannot carry it. */
  held: TailnetNotice | null;
  /** Add to the error when the connection then cannot reach the other PC. */
  ifUnreachable: TailnetNotice | null;
}

const NOTHING: TailnetVerdict = { held: null, ifUnreachable: null };

/** What Tailscale's state means for a connection to `host` (see the table at the top). */
export function judgeTailnet(host: string, list: TailscaleChecklist | null): TailnetVerdict {
  const failed = blockingFailure(list);
  if (!failed || !isTailnetHost(host)) return NOTHING;
  const named = isTailnetName(host);
  // The status found no device with this address: not a Tailscale one.
  if (!named && failed.reason === 'no-peer') return NOTHING;
  const note: TailnetNotice = { text: describeTailnetFailure(failed, host), ...(failed.fix ? { fix: failed.fix } : {}) };
  // A peer-offline match means the status itself lists the address.
  const sure = named || failed.reason === 'peer-offline';
  return {
    held: sure ? { ...note, text: `${note.text} ${t('tailscale.notTried')}` } : null,
    ifUnreachable: note,
  };
}

/** `text` with the Tailscale reason after it, when there is one. */
export function withTailnetNote(text: string, note: TailnetNotice | null): string {
  return note ? `${text} ${note.text}` : text;
}

/**
 * One sentence for a failed check, naming the device when the check looked
 * for one ("desk.tail1.ts.net isn't on your tailnet") rather than for any.
 */
export function describeTailnetFailure(item: TailscaleCheckItem, peerName?: string): string {
  if (peerName && item.reason === 'no-peer') return t('tailscale.reason.peerMissing', { name: peerName });
  if (peerName && item.reason === 'peer-offline') return t('tailscale.reason.peerOfflineNamed', { name: peerName });
  return item.reason ? t(`tailscale.reason.${item.reason}`) : t('tailscale.unavailable');
}

/** The checklist button for a `wmux web --tailscale` problem, when one helps. */
export function fixForProblem(problem: TailscaleProblem | string | undefined): TailscaleFix | null {
  switch (problem) {
    case 'not-installed':
      return 'download';
    case 'not-running':
    case 'stopped':
      return 'open-app';
    case 'not-logged-in':
    case 'needs-machine-auth':
      return 'sign-in';
    default:
      return null;
  }
}

/**
 * The pre-connect check every entry point runs on a tailnet-range host: what
 * to show at once instead of connecting, and what to add if the connection
 * then fails to reach the other PC. One status read; none for other hosts.
 */
export async function tailnetPrecheck(host: string | null): Promise<TailnetVerdict> {
  if (!host || !isTailnetHost(host)) return NOTHING;
  return judgeTailnet(host, await readTailscale(host));
}

/** Ask main for the checklist; null when the bridge is missing or the call failed. */
export async function readTailscale(peer?: string): Promise<TailscaleChecklist | null> {
  const check = window.electronAPI?.web?.tailscaleCheck;
  if (!check) return null;
  try {
    return await check(peer);
  } catch {
    return null;
  }
}
