// ─── The default bot engine's readiness (FACTORY_ENGINE_READINESS) ─────────
//
// Whether a bot on the default engine (Claude through the Agent SDK) can run
// on this computer, answered without a model turn: the claude executable is
// found and a Claude sign-in is stored. Never carries a credential or any
// part of one.

export type FactoryEngineNotReadyReason = 'claude-not-installed' | 'claude-not-logged-in' | 'unknown';

export interface FactoryEngineReadiness {
  ready: boolean;
  /** Set when `ready` is false. */
  reason?: FactoryEngineNotReadyReason;
  /** A short, credential-free detail for the owner (English). */
  message?: string;
}
