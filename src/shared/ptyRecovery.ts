import { isWslDistroSpawnArgs } from './wslDistro';
import { validWslTarget, type WslTarget } from './wslTarget';
import { isAgentSlug, type AgentSlug } from './agentIdentity';
import { isUsableResumeBinding, type ResumeBinding } from './agentResume';

/**
 * Minimal metadata carried while a renderer surface replaces a known-dead
 * daemon session. Both cwd candidates remain untrusted until main validates
 * them at PTY-create time.
 */
export interface DeadPaneRecovery {
  /** Lookup key only; main reads target/user from the daemon, never renderer argv. */
  sourceSessionId?: string;
  /** Legacy distro-only recovery metadata from #1245. */
  args?: string[];
  wslTarget?: WslTarget;
  spawnCwd?: string;
  cwd?: string;
  resumeAgent?: AgentSlug;
  resumeBinding?: ResumeBinding;
}

export interface DeadPaneSessionSnapshot {
  id?: string;
  /** Legacy distro-only recovery metadata from #1245. */
  args?: string[];
  wslTarget?: WslTarget;
  spawnCwd?: string;
  cwd?: string;
  /** Untrusted daemon/RPC value; normalized before entering renderer state. */
  resumeAgent?: string;
  resumeBinding?: ResumeBinding;
}

function nonBlank(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export function asRecoveryAgentSlug(value: string | undefined): AgentSlug | undefined {
  return value !== undefined && isAgentSlug(value) ? value : undefined;
}

/**
 * Build the renderer hand-off from a daemon tombstone. A descriptor is
 * returned even when both cwd fields are absent: its presence tells the create
 * path this is a dead-session replacement, for which home is the final fallback
 * instead of the workspace profile used by ordinary blank surfaces.
 */
export function createDeadPaneRecovery(session: DeadPaneSessionSnapshot): DeadPaneRecovery {
  const resumeBinding = session.resumeBinding;
  const resumeAgent = asRecoveryAgentSlug(session.resumeAgent)
    ?? asRecoveryAgentSlug(resumeBinding?.agent);
  return {
    ...(session.id ? { sourceSessionId: session.id } : {}),
    ...(isWslDistroSpawnArgs('wsl.exe', session.args) ? { args: [...session.args] } : {}),
    ...(validWslTarget(session.wslTarget) ? { wslTarget: { ...session.wslTarget } } : {}),
    ...(nonBlank(session.spawnCwd) ? { spawnCwd: session.spawnCwd } : {}),
    ...(nonBlank(session.cwd) ? { cwd: session.cwd } : {}),
    ...(resumeAgent ? { resumeAgent } : {}),
    ...(resumeBinding ? { resumeBinding } : {}),
  };
}

/** Carry a still-pending resume offer across a second replacement. */
export function mergeDeadPaneRecovery(
  previous: DeadPaneRecovery | undefined,
  incoming: DeadPaneRecovery,
): DeadPaneRecovery {
  if (!previous) return incoming;
  return {
    ...previous,
    ...incoming,
    ...(incoming.resumeAgent ?? previous.resumeAgent
      ? { resumeAgent: incoming.resumeAgent ?? previous.resumeAgent }
      : {}),
    ...(incoming.resumeBinding ?? previous.resumeBinding
      ? { resumeBinding: incoming.resumeBinding ?? previous.resumeBinding }
      : {}),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * #2398 — re-validate a descriptor read back from session.json, which is
 * user-editable and may come from another build. The same rules as a fresh
 * daemon tombstone, plus a resume binding must have the fields its consumers
 * read. Anything that is not an object is dropped; an object with nothing
 * valid left stays an empty descriptor, because its presence alone means
 * "replace a dead session" (home, not the workspace profile, is the fallback).
 */
export function normalizeDeadPaneRecovery(raw: unknown): DeadPaneRecovery | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const args = Array.isArray(r.args) && r.args.every((a) => typeof a === 'string') ? (r.args as string[]) : undefined;
  return createDeadPaneRecovery({
    id: stringField(r.sourceSessionId),
    args,
    wslTarget: r.wslTarget as WslTarget | undefined,
    spawnCwd: stringField(r.spawnCwd),
    cwd: stringField(r.cwd),
    resumeAgent: stringField(r.resumeAgent),
    resumeBinding: isUsableResumeBinding(r.resumeBinding) ? r.resumeBinding : undefined,
  });
}
