import type { AgentSignal, AgentSignalKind } from './signal-types';

// Payload time, not the authority map's receipt time: a delayed hook must
// not become fresh identity evidence merely because it arrived just now.
export const DETECTOR_IDENTITY_HOOK_MAX_AGE_MS = 2 * 60_000;

const IDENTITY_KINDS: ReadonlySet<AgentSignalKind> = new Set([
  'agent.session_start',
  'agent.user_prompt_submit',
  'agent.activity',
  'agent.tool_started',
  'agent.awaiting_input',
  'agent.awaiting_permission',
]);

/** A lead agent's positive evidence, never an old terminal or child event. */
export function isHookIdentityCandidate(signal: AgentSignal): boolean {
  if (!IDENTITY_KINDS.has(signal.kind)) return false;
  // Both real Claude subagents and internal suggestion/recap forks carry
  // agent_id. Neither can claim the foreground identity of its parent's PTY.
  const childId = signal.payload?.agent_id;
  return !(typeof childId === 'string' && childId.length > 0);
}

/**
 * Shared admission rule for the daemon and local fallback. Call only after
 * the normal hook ingress accepted the signal for a live pane. Daemon callers
 * must additionally reject a conflicting attributed live process.
 *
 * The boundary is the detector's latest shell return / identity invalidation.
 * Equal timestamps cannot establish which launch sent the signal; wait for
 * newer evidence. Future timestamps are likewise not evidence of freshness.
 */
export function canSeedHookIdentity(
  signal: AgentSignal,
  context: { ptyId: string; now: number; boundaryAt: number },
): boolean {
  return isHookIdentityCandidate(signal)
    && context.ptyId.length > 0
    && signal.ptyId === context.ptyId
    && Number.isFinite(signal.ts)
    && signal.ts > 0
    && signal.ts <= context.now
    && context.now - signal.ts <= DETECTOR_IDENTITY_HOOK_MAX_AGE_MS
    && signal.ts > context.boundaryAt;
}
