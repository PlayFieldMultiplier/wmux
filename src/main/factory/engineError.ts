// ─── Classify a bot engine_unavailable message for the owner UI ────────────
//
// BotRuntime stores the raw English refusal (truncated) on lastError and parks
// the bot. The Bots page used to show that English string and "stopped with
// error". These codes map known causes to localized cards with a Fix action;
// the raw detail stays available behind a details toggle. Pure: never throws.

export type EngineErrorCode =
  | 'not_installed'
  | 'not_logged_in'
  | 'mcp_missing'
  | 'acp_test_only'
  | 'unusable'
  | 'other';

const RULES: readonly { code: EngineErrorCode; re: RegExp }[] = [
  { code: 'not_installed', re: /claude code is not installed|no claude executable|claude code (native binary|executable) not found/i },
  { code: 'not_logged_in', re: /not signed in|not logged in|sign-?in could not be read|claude auth login/i },
  { code: 'mcp_missing', re: /mcp bundle was not found|would have no tools/i },
  { code: 'acp_test_only', re: /acp engines run bots only in a test build|acp stub is not available/i },
  // The SDK's own launch failures: the process did not spawn, or the
  // native binary is there and fails to start.
  { code: 'unusable', re: /claude --version|could not run claude|claude is installed but|failed to spawn claude code process|exists but failed to launch/i },
];

/** Map a raw engine_unavailable (or similar) message to a stable code. Pure. */
export function classifyEngineError(message: string): EngineErrorCode {
  const m = typeof message === 'string' ? message : '';
  for (const r of RULES) {
    if (r.re.test(m)) return r.code;
  }
  return 'other';
}
