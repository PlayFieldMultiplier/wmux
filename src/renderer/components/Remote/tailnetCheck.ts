import type { TailscaleProblem } from '../../../cli/tailscale';
import type { TailscaleCheckItem, TailscaleChecklist, TailscaleFix } from '../../../shared/web';
import { isTailnetIpv4, parseInvite } from '../../../shared/a2aRemote';
import { parseRemotePairInput } from '../../../shared/remotePairInput';
import { t } from '../../i18n';

// ─── Tailscale, as the Remote page and its connections see it ────────────────
//
// The checks themselves run in main (`web.tailscaleCheck`, one read-only
// `tailscale status --json`); this module only decides what a connection does
// with the answer. A connection is held back only when its address is on the
// tailnet AND a check failed for a reason a person can fix. "Could not read
// the status" (or a missing bridge) never blocks: the connection then tries
// exactly as it did before.

/** A MagicDNS name or a tailnet (100.64.0.0/10) address. */
export function isTailnetHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return isTailnetIpv4(h) || h.endsWith('.ts.net');
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
 * The failure that should stop a connection before it starts: any failed
 * check except an unreadable status, which says nothing either way.
 */
export function blockingFailure(list: TailscaleChecklist | null): TailscaleCheckItem | null {
  const item = failedCheck(list);
  return item && item.reason !== 'unreadable' ? item : null;
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
 * The pre-connect check every entry point runs on a tailnet host: null to go
 * ahead, else the sentence to show at once and the one button that fixes it.
 */
export async function tailnetPrecheck(host: string | null): Promise<{ text: string; fix?: TailscaleFix } | null> {
  if (!host || !isTailnetHost(host)) return null;
  const blocked = blockingFailure(await readTailscale(host));
  if (!blocked) return null;
  return {
    text: `${describeTailnetFailure(blocked, host)} ${t('tailscale.notTried')}`,
    ...(blocked.fix ? { fix: blocked.fix } : {}),
  };
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
