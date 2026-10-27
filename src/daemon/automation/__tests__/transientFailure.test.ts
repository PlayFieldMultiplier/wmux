import { describe, expect, it } from 'vitest';
import { classifyClaudeStopFailure, classifyCodexTurnCompleted } from '../../../shared/phoneTurnFailure';
import { isTransientTurnFailure, shouldPushTurnFailure } from '../transientFailure';

const claude = (error: string) => classifyClaudeStopFailure({ error }, 1);
const codex = (codexErrorInfo: unknown) => {
  const f = classifyCodexTurnCompleted({ status: 'failed', error: { message: 'boom', codexErrorInfo } }, 1);
  if (!f) throw new Error('not a failure');
  return f;
};

describe('isTransientTurnFailure', () => {
  it('counts network failures and provider overload or server errors', () => {
    expect(isTransientTurnFailure(codex({ httpConnectionFailed: { httpStatusCode: null } }), false)).toBe(true);
    expect(isTransientTurnFailure(codex({ responseStreamDisconnected: { httpStatusCode: 502 } }), false)).toBe(true);
    expect(isTransientTurnFailure(codex({ responseTooManyFailedAttempts: { httpStatusCode: 503 } }), false)).toBe(true);
    expect(isTransientTurnFailure(codex('serverOverloaded'), false)).toBe(true);
    expect(isTransientTurnFailure(claude('overloaded'), false)).toBe(true);
    expect(isTransientTurnFailure(claude('server_error'), false)).toBe(true);
  });

  it('counts a short throttle, but never a usage limit', () => {
    expect(isTransientTurnFailure(codex('rateLimitExceeded'), false)).toBe(true);
    expect(isTransientTurnFailure(claude('rate_limit'), false)).toBe(true);
    expect(isTransientTurnFailure(claude('rate_limit'), true)).toBe(false);
    expect(isTransientTurnFailure(codex('usageLimitExceeded'), false)).toBe(false);
  });

  it('leaves auth, quota and other failures final', () => {
    for (const f of [
      claude('authentication_failed'), claude('billing_error'), claude('max_output_tokens'), claude('unknown'),
      codex('unauthorized'), codex('contextWindowExceeded'), codex('sessionBudgetExceeded'),
      codex({ responseTooManyFailedAttempts: { httpStatusCode: 401 } }), codex(null),
    ]) {
      expect(isTransientTurnFailure(f, false), JSON.stringify(f)).toBe(false);
    }
  });
});

describe('shouldPushTurnFailure', () => {
  it('holds the push only when the hold was actually armed', () => {
    let asked = 0;
    expect(shouldPushTurnFailure(true, () => { asked++; return true; })).toBe(false);
    // Arming refused (setting off, opt-out, already retried): the push goes out.
    expect(shouldPushTurnFailure(true, () => { asked++; return false; })).toBe(true);
    // Not transient: arming is never asked.
    expect(shouldPushTurnFailure(false, () => { asked++; return true; })).toBe(true);
    expect(asked).toBe(2);
  });
});
