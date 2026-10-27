// Which failed agent turns of a scheduled run count as a temporary provider
// error: the run is then held and continued once instead of ending at once.
//
// Decided from the classified failure (shared/phoneTurnFailure) plus the
// provider's own code, without remapping the phone contract's reasons:
// Claude's `overloaded` and `server_error` classify as `unknown` there, and
// stay so.

import type { TurnFailure } from '../../shared/phoneTurnFailure';

/** Wait before the one continue message. */
export const TRANSIENT_RETRY_DELAY_MS = 5 * 60_000;
/**
 * A pane only momentarily not ready for the continue (a repaint, a slow
 * screen read, a draft) is asked again on later passes for this long past
 * the due time; then the run ends failed.
 */
export const TRANSIENT_RETRY_READY_GRACE_MS = 60_000;

/** Claude StopFailure codes for a provider overload or server error. */
const CLAUDE_TRANSIENT_CODES: ReadonlySet<string> = new Set(['overloaded', 'server_error']);
/** Codex CodexErrorInfo variants for a provider overload or a broken connection. */
const CODEX_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'serverOverloaded', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
]);

/**
 * `usageLimit`: the failure carried a usage-limit notice (Claude reports a
 * subscription cap as `rate_limit` too). That case belongs to the usage-limit
 * registry, which holds the pane until the reset, so it is never transient.
 */
export function isTransientTurnFailure(
  failure: Pick<TurnFailure, 'reason' | 'provider' | 'providerCode' | 'httpStatus'>,
  usageLimit: boolean,
): boolean {
  switch (failure.reason) {
    case 'network':
      return true;
    case 'rate-limited':
      return !usageLimit;
    case 'auth':
    case 'quota':
      return false;
    default: {
      const code = failure.providerCode;
      if (code && (failure.provider === 'claude' ? CLAUDE_TRANSIENT_CODES : CODEX_TRANSIENT_CODES).has(code)) return true;
      const status = failure.httpStatus;
      return failure.provider === 'codex' && status !== undefined && status >= 500 && status <= 599;
    }
  }
}

/**
 * The turn-failed push for a scheduled run's pane goes out unless the engine
 * actually armed the hold: only the final failure notifies. `arm` is asked
 * only for a transient failure, and arms the hold when it answers true.
 */
export function shouldPushTurnFailure(transient: boolean, arm: () => boolean): boolean {
  return !(transient && arm());
}
