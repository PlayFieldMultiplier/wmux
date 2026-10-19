// ─── The default bot engine's readiness (FACTORY_ENGINE_READINESS) ─────────
//
// Whether a bot on the default engine (Claude through the Agent SDK) can run
// on this computer, answered without a model turn: the claude executable is
// found, a Claude sign-in is stored, and a cheap `claude --version` probe
// succeeds. Never carries a credential or any part of one.

/** Official Claude Code install / setup page (https only; opened via shell.openExternal). */
export const CLAUDE_CODE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup';

export type FactoryEngineNotReadyReason =
  | 'claude-not-installed'
  | 'claude-not-logged-in'
  | 'claude-unusable'
  | 'unknown';

export interface FactoryEngineReadiness {
  ready: boolean;
  /** Set when `ready` is false. */
  reason?: FactoryEngineNotReadyReason;
  /** A short, credential-free detail for the owner (English). */
  message?: string;
}
