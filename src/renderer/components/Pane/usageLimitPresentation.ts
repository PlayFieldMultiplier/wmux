// Pure text/state for a pane's usage-limit hold, shared by the pane-header
// chip and the Fleet row so the two never word the same limit differently.
import { formatResetClock, formatResetDuration, type PaneUsageLimit } from '../../../shared/usageLimit';
import type { TranslationKey } from '../../i18n/locales/en';
import { chooseByQuota, type QuotaVerdict } from '../../../shared/accountQuota';

export type UsageLimitPhase = 'waiting' | 'unknown' | 'reset';

export interface UsageLimitView {
  phase: UsageLimitPhase;
  /** "3:16 PM" (or "Sep 26, 3:16 PM"); undefined when the reset is unknown. */
  clock?: string;
  /** "2h 4m" until the reset; undefined unless waiting. */
  duration?: string;
  /** Armed to send the continue message at the reset. */
  armed: boolean;
  /** The Resume-at-reset toggle only makes sense ahead of a known reset. */
  canArm: boolean;
  /** Resume now: once the reset passed, or when nobody knows when it is. */
  canResumeNow: boolean;
}

export function usageLimitView(limit: PaneUsageLimit, now: number, locale?: string): UsageLimitView {
  const known = limit.resetsAt != null;
  const phase: UsageLimitPhase = !known ? 'unknown' : now >= (limit.resetsAt as number) ? 'reset' : 'waiting';
  return {
    phase,
    ...(known ? { clock: formatResetClock(limit.resetsAt as number, now, locale) } : {}),
    ...(phase === 'waiting' ? { duration: formatResetDuration((limit.resetsAt as number) - now) } : {}),
    armed: limit.autoResume === true,
    canArm: phase === 'waiting',
    canResumeNow: phase !== 'waiting',
  };
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The chip's status text: "resets 3:16 PM · 2h 4m" / "reset time unknown" / "Limit has reset". */
export function usageLimitStatusText(view: UsageLimitView, t: Translate): string {
  if (view.phase === 'reset') return t('usageLimit.hasReset');
  if (view.phase === 'unknown') return t('usageLimit.resetUnknown');
  return t('usageLimit.resets', { clock: view.clock ?? '', duration: view.duration ?? '' });
}

/** Fleet detail line: "Usage limit · resets 3:16 PM (in 2h 4m)". */
export function usageLimitFleetDetail(view: UsageLimitView, t: Translate): string {
  if (view.phase === 'reset') return t('usageLimit.fleetDetailReset');
  if (view.phase === 'unknown') return t('usageLimit.fleetDetailUnknown');
  return t('usageLimit.fleetDetail', { clock: view.clock ?? '', duration: view.duration ?? '' });
}

/**
 * When every registered account of `vendor` is out of quota: the epoch ms
 * the first one reopens, or null when none says when. Undefined while any
 * account still has quota, or with no readings (switch-by-quota reads quota
 * only while it is on). Pure.
 */
export function everyAccountOutUntil(
  rows: readonly { accountId: string; vendor: string; verdict: QuotaVerdict }[],
  vendor: string,
  now: number,
): number | null | undefined {
  const own = rows.filter((r) => r.vendor === vendor);
  if (own.length === 0) return undefined;
  const choice = chooseByQuota(own.map((r) => ({ id: r.accountId, verdict: r.verdict, current: false })));
  if (choice.kind !== 'hold') return undefined;
  if (choice.availableAtMs === null) return null;
  return choice.availableAtMs > now ? choice.availableAtMs : undefined;
}
