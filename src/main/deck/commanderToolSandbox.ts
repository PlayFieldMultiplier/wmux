// ─── Command Deck — commander tool permission sandbox (M1b) ──────────────────
//
// The orchestrator brain now holds exactly ONE built-in hand: Write. Every rule
// governing that grant lives here, deliberately SDK-free, so it can be unit
// tested without a live model or subprocess. The adapter installs this as the
// SDK's `options.canUseTool` permission callback, which fires for every tool
// that is NOT auto-allowed via `allowedTools`. Because `allowedTools` BYPASSES
// this callback, Write is kept OUT of the allow-list on purpose — the only path
// Write can reach the disk is through this evaluator, and this evaluator is
// fail-closed by construction.
//
// Policy in one sentence: Write is permitted IFF it targets a `.md` file that
// resolves STRICTLY inside the brain's own memory partitions — the shared
// `<memoryRoot>/_global/` or its own `<memoryRoot>/<workspaceId>/` — and every
// other tool that reaches the callback is denied. That preserves the previous
// fail-closed behaviour for anything that used to need a permission prompt
// (Bash, Edit, WebFetch, …): none of them are available.
//
// Traversal defence: the candidate path is `path.resolve`d (collapsing any
// `../` segments) and required to sit under the partition dir plus a trailing
// separator, so neither the partition dir itself nor a sibling that merely
// shares the textual prefix (`<dir>-evil`) can match. On win32 the comparison
// is case-insensitive (the filesystem is), and that mode is injectable so the
// win32 branch stays testable on any host.

import * as fs from 'fs';
import * as path from 'path';

/** The subset of the SDK's PermissionResult this evaluator ever returns. A deny
 *  always carries a message (the SDK requires one). */
export type ToolPermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

// A workspaceId is consumed as a SINGLE path segment, so it must not traverse
// (`../evil`), name the parent (`.`/`..`), or nest (`a/b`). This mirrors
// commanderMemory's SAFE_WORKSPACE_ID EXACTLY: the two must agree, or the brain
// could read from a partition it cannot write, or vice versa. Anything outside
// the whitelist collapses to _global-only (never a path traversal, never a
// throw).
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9._-]{1,80}$/;

function sanitizeWorkspaceId(id: string | undefined): string | null {
  if (!id || !SAFE_WORKSPACE_ID.test(id) || id === '.' || id === '..') return null;
  return id;
}

export interface CommanderToolPermissionOptions {
  /** Root of the memory store (holds `_global/` and the per-workspace
   *  partitions) — the same dir commanderMemory.getMemoryRootDir() returns. */
  memoryRoot: string;
  /** The one workspace this brain serves; gates access to the per-workspace
   *  partition. Absent/invalid → only `_global/` is writable. */
  workspaceId?: string;
  /** Path-comparison mode. Defaults to the running platform (win32 = case
   *  insensitive). Injectable purely so the win32 branch is coverable on a
   *  case-sensitive CI host and vice versa. */
  caseInsensitive?: boolean;
}

/**
 * Whether `candidate` resolves STRICTLY inside `dir`: not `dir` itself, and not
 * a sibling that shares the textual prefix. `..` segments are collapsed by
 * path.resolve before the comparison, so traversal cannot escape.
 */
function isStrictlyInside(candidate: string, dir: string, caseInsensitive: boolean): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedCandidate = path.resolve(candidate);
  // Require the separator in the prefix so `<dir>` and `<dir>-sibling` fail; a
  // file placed directly in `<dir>` still matches (`<dir>/x.md`).
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  const cand = caseInsensitive ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const pre = caseInsensitive ? prefix.toLowerCase() : prefix;
  return cand.startsWith(pre);
}

/**
 * The commander brain's sole permission gate. Returns `allow` only for a Write
 * into an own memory partition (`.md`, no escape); denies everything else with
 * a short message. Never throws — any internal error degrades to a deny, so a
 * broken evaluator can neither open the disk nor kill the turn.
 */
export function evaluateCommanderToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  opts: CommanderToolPermissionOptions,
): ToolPermissionResult {
  try {
    if (toolName !== 'Write') {
      // Fail closed for every other prompt-needing tool — matches the old
      // "unlisted tool is auto-denied" behaviour now that the callback exists.
      return { behavior: 'deny', message: `${toolName} is not available to the orchestrator.` };
    }
    const filePath = (input as { file_path?: unknown } | null)?.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { behavior: 'deny', message: 'Write requires a string file_path.' };
    }
    // `.md` only — memory is a set of small markdown facts, never arbitrary
    // files. Case-insensitive so `.MD` is not a bypass.
    if (!filePath.toLowerCase().endsWith('.md')) {
      return { behavior: 'deny', message: 'The orchestrator may only write .md memory files.' };
    }
    const caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
    // The shared global partition is always writable; the workspace partition
    // only when a valid workspaceId is bound (own partition, never another's).
    const allowedDirs: string[] = [path.join(opts.memoryRoot, '_global')];
    const wsId = sanitizeWorkspaceId(opts.workspaceId);
    if (wsId) allowedDirs.push(path.join(opts.memoryRoot, wsId));
    for (const dir of allowedDirs) {
      if (isStrictlyInside(filePath, dir, caseInsensitive)) {
        return { behavior: 'allow' };
      }
    }
    return {
      behavior: 'deny',
      message:
        'The orchestrator can only write memory files inside its _global or workspace folder.',
    };
  } catch {
    // Defence in depth: the adapter also wraps this call, but a fail-closed
    // deny here guarantees a thrown path helper never becomes an accidental
    // allow (or an unhandled rejection that ends the turn).
    return { behavior: 'deny', message: 'Write permission check failed.' };
  }
}
