// Validation for the `transcript_path` a hook payload asks the daemon to
// persist on a pane's resume binding.
//
// The hook envelope is AUTHENTICATED but not TRUSTED: the token proves the
// caller can read the daemon token file, not that the values inside the payload
// are the ones Claude Code would have sent. Whatever lands in
// `resumeBinding.transcriptPath` is later opened and read by the daemon
// (`TranscriptProjector`) and its contents are rendered as a pane's
// conversation, so an unvalidated path is a daemon-side arbitrary-file-read
// primitive with a UI attached — point it at `~/.ssh/config` or a secrets file
// and the "chat" shows the file.
//
// Two conditions, both cheap, together leaving nothing useful to point at:
//   1. the path must resolve INSIDE the Claude projects root, and
//   2. its basename must be exactly `${agentSessionId}.jsonl` — the same id the
//      bridge already derived from the transcript basename, so a real payload
//      satisfies it by construction while a forged one has to guess a uuid it
//      does not control.
//
// `realpath` is used where it can be: containment has to be checked on the
// RESOLVED path or a symlink inside the projects directory walks straight out of
// it. A transcript that does not exist yet cannot be resolved, so its nearest
// existing ancestor is, and the check marks it `pending`: Claude writes the
// file on its first prompt, so until then readers serve an empty conversation.
// Every read re-runs this check, so the file that appears is judged again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WslTarget } from '../../shared/wslTarget';
import { isValidWslDistroName } from '../../shared/wslDistro';
import { win32AliasedName } from '../../mcp/wslPaths';
import { agentRow } from '../../shared/agentIdentity';

/** Separator-agnostic last segment. Windows paths relayed to a POSIX daemon (or
 *  replayed from a state file written elsewhere) must not come back whole. */
function lastSegment(value: string): string {
  const segments = value.replace(/\\/g, '/').split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return '';
}

/** Lexically normalize for comparison: one separator, resolved `.`/`..`. */
function normalizeForCompare(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/');
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbsolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  const prefix = unified.startsWith('//') ? '//' : isAbsolute ? '/' : '';
  // Windows drive letters and macOS/Windows filesystems are case-insensitive;
  // comparing case-sensitively there would reject a legitimate `C:\Users\…` that
  // differs only in case from the derived root.
  const full = `${prefix}${joined}`;
  return process.platform === 'linux' ? full : full.toLowerCase();
}

/** Is `candidate` the same as, or inside, `root`? Both already normalized. */
function isInside(candidate: string, root: string): boolean {
  if (!root) return false;
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** `realpath` when the path exists (a not-yet-created transcript is legal —
 *  SessionStart fires before the `.jsonl` is written).
 *
 *  When it does not exist, the NEAREST EXISTING ANCESTOR is resolved and the
 *  remainder kept lexical: containment still has to be judged on resolved
 *  ground, and a home directory reached through a symlink (or macOS's
 *  `/var` → `/private/var`) would otherwise make a legitimate provisional path
 *  look like it sits outside the projects root, silently disabling Chat View. */
function resolveIfPossible(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    // Not created yet — fall through to the ancestor walk.
  }
  const rest: string[] = [];
  let current = value;
  // Bounded: a pathological path must not turn containment into a long walk.
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    rest.unshift(path.basename(current));
    try {
      return path.join(fs.realpathSync(parent), ...rest);
    } catch {
      current = parent;
    }
  }
  return value;
}

/**
 * Directories a Claude transcript may legitimately live under.
 *
 * `~/.claude/projects` is the default. `CLAUDE_CONFIG_DIR` relocates it, and
 * wmux already lets a workspace profile set that variable per pane
 * (`workspaceSlice` profile env), so the RESOLVED session's env is consulted
 * too — otherwise a user with a relocated config dir would silently lose Chat
 * View rather than be protected by anything.
 */
export function claudeProjectRoots(sessionEnv?: Record<string, string>): string[] {
  const roots: string[] = [path.join(os.homedir(), '.claude', 'projects')];
  const configured = sessionEnv?.['CLAUDE_CONFIG_DIR'] || process.env['CLAUDE_CONFIG_DIR'];
  if (configured) roots.push(path.join(configured, 'projects'));
  return roots;
}

/**
 * The one directory the pane's Claude reads and writes its transcripts under:
 * `$CLAUDE_CONFIG_DIR/projects` when the session names an account folder, else
 * `~/.claude/projects`. Claude never looks in the default root once
 * `CLAUDE_CONFIG_DIR` is set, so a file there is another account's. Finding a
 * transcript searches this root alone; claudeProjectRoots above is where a
 * transcript is allowed to be, which is wider. The session's environment is the
 * pane's whole environment: a session that leaves the variable out or empty
 * runs on the default root, whatever the daemon's own environment says (an
 * unbound workspace drops inherited account variables on purpose). The
 * daemon's is consulted only when no session environment is known.
 */
export function claudeTranscriptRoot(sessionEnv?: Record<string, string>): string {
  const configured = sessionEnv ? sessionEnv['CLAUDE_CONFIG_DIR'] : process.env['CLAUDE_CONFIG_DIR'];
  return configured ? path.join(configured, 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

/** An absolute path in this host's own syntax: a drive path on Windows, `/…` elsewhere. */
export function isHostAbsolute(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith('/');
}

/**
 * Where a transcript Claude has not written yet will land, or null when that
 * cannot be proven. Claude names its transcript at session start but writes it
 * on the first prompt, so a bare launch sits at its prompt with no file. Every
 * missing component must be truly absent (nothing at all, not even a dangling
 * link, which realpath reports as missing too), the path has no `.` or `..`
 * segment, and the nearest component that does exist must resolve to a
 * directory: the file, once written, is the resolved directory plus plain names.
 */
function notCreatedYetTarget(transcriptPath: string): string | null {
  if (transcriptPath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return null;
  const missing: string[] = [];
  let current = transcriptPath;
  for (let i = 0; i < 64; i++) {
    let occupied = false;
    try {
      fs.lstatSync(current);
      occupied = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    if (occupied) {
      try {
        const real = fs.realpathSync(current);
        return fs.statSync(real).isDirectory() ? path.join(real, ...missing) : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) return null;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return null;
}

export interface TranscriptPathCheck {
  ok: boolean;
  /** Why it was refused, for the warn log. Empty when `ok`. */
  reason: string;
  /**
   * `ok` for a file the agent has not created yet: its containment was proven
   * on the nearest existing ancestor (Codex writes its session file lazily, on
   * the first turn, and Claude its transcript on the first prompt). Readers treat a still-missing file as an empty conversation.
   */
  pending?: boolean;
}

/**
 * Is this hook-supplied `transcript_path` safe to persist for `agentSessionId`?
 *
 * Refusal is not a fallback to something looser — the binding is stored without
 * a transcript path, which degrades to "Chat View unavailable" for that pane and
 * changes nothing else about the signal.
 */
export function checkTranscriptPath(
  transcriptPath: string,
  agentSessionId: string,
  sessionEnv?: Record<string, string>,
): TranscriptPathCheck {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  if (transcriptPath.includes('\u0000')) return { ok: false, reason: 'nul-byte' };
  if (!agentSessionId) return { ok: false, reason: 'no-agent-session-id' };

  const expected = `${agentSessionId}.jsonl`;
  const actual = lastSegment(transcriptPath);
  // Case-insensitive because the two filesystems that matter here are, and the
  // id is a uuid either way.
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: `basename ${actual} != ${expected}` };
  }

  // An existing transcript is judged on its realpath and must be a regular
  // file itself (a link at the name could name another session's file). A
  // missing one in this host's syntax only through notCreatedYetTarget; any
  // other failure refuses.
  let target: string | null;
  let pending = false;
  let foreign = false;
  try {
    target = fs.realpathSync(transcriptPath);
    if (!fs.lstatSync(transcriptPath).isFile()) return { ok: false, reason: 'not a regular file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
    if (isHostAbsolute(transcriptPath)) {
      target = notCreatedYetTarget(transcriptPath);
      if (!target) return { ok: false, reason: 'not a file Claude has yet to write' };
      pending = true;
    } else {
      // The other OS's syntax (a path relayed or replayed from there): this
      // process cannot open it as that file, so it is judged lexically, as it
      // always was, and never served as an empty conversation.
      target = transcriptPath;
      foreign = true;
    }
  }
  const resolved = normalizeForCompare(target);
  for (const root of claudeProjectRoots(sessionEnv)) {
    if (isInside(resolved, normalizeForCompare(foreign ? root : resolveIfPossible(root)))) {
      return { ok: true, reason: '', ...(pending ? { pending: true } : {}) };
    }
  }
  return { ok: false, reason: 'outside the Claude projects root' };
}

/**
 * Is this the `transcript_path` a WSL pane's own Claude reports: the Linux path
 * `~/.claude/projects/<project>/<session id>.jsonl` of the pane's distro user
 * (`/home/<user>/…`, or `/root/…` for root)?
 *
 * Never stored as `transcriptPath`: this process cannot open a distro path as
 * given (on Windows `/home/u/…` names `C:\home\u\…`, a different file). The
 * caller keeps it as the binding's `wslTranscriptPath`, which only
 * resolveWslTranscriptPath below turns into a file to read. Purely lexical, case-sensitive like the
 * Linux filesystem it names, and nothing outside that one directory matches:
 * no `.`/`..`/empty segment, no control or backslash character.
 */
export function isWslOwnTranscriptPath(
  transcriptPath: string,
  agentSessionId: string,
  target: Partial<WslTarget> | undefined,
): boolean {
  const user = target?.user;
  if (typeof user !== 'string' || !user || user.includes('/') || user === '.' || user === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (!agentSessionId || typeof transcriptPath !== 'string' || /[\u0000-\u001f\u007f\\]/.test(transcriptPath)) return false;
  const root = `${user === 'root' ? '/root' : `/home/${user}`}/.claude/projects/`;
  if (!transcriptPath.startsWith(root)) return false;
  const rest = transcriptPath.slice(root.length).split('/');
  if (rest.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return rest.length === 2 && rest[1] === `${agentSessionId}.jsonl`;
}

/**
 * The writer half for `wslTranscriptPath`: kept only when it is the pane's own
 * Claude transcript (`target` is the pane's recorded WSL target, absent for any
 * other pane); otherwise the binding goes without it. `dropped` says so.
 */
export function keepOwnWslTranscriptPath<B extends { agent: string; sessionId: string; wslTranscriptPath?: string }>(
  binding: B,
  target: Partial<WslTarget> | undefined,
): { binding: B; dropped: boolean } {
  if (binding.wslTranscriptPath === undefined) return { binding, dropped: false };
  if (agentRow(binding.agent)?.wslTranscript && isWslOwnTranscriptPath(binding.wslTranscriptPath, binding.sessionId, target)) {
    return { binding, dropped: false };
  }
  const rest = { ...binding };
  delete rest.wslTranscriptPath;
  return { binding: rest, dropped: true };
}

/** Where a distro's own filesystem is reachable from Windows. */
export function wslShareRoot(distro: string): string {
  return `\\\\wsl$\\${distro}`;
}

export type WslTranscriptResolution =
  | { ok: true; hostPath: string; pending?: boolean }
  | { ok: false; reason: string };

/**
 * The file this process reads for a WSL pane's `wslTranscriptPath`: the same
 * file seen through the pane's distro share (`\\wsl$\<distro>\home\<user>\…`).
 *
 * The distro and user come from `target`, the pane's own record of where it
 * runs; the path must be that user's transcript for `agentSessionId`
 * (isWslOwnTranscriptPath) and hold no name Windows reads differently. On
 * disk, the file must be a regular file that resolves to exactly that path:
 * a link anywhere on it resolves elsewhere (on the share, a link cannot even
 * be resolved), so nothing outside the user's projects folder is reachable.
 * A file Claude has not written yet is `pending`, an empty conversation, only
 * when its project folder resolves to itself the same way. Anything that
 * cannot be proven is refused. Callers re-run this on every read, as for
 * checkTranscriptPath; it costs one realpath and one lstat on the share.
 *
 * `shareRoot` exists for tests, which stand a temporary folder in for the share.
 */
export function resolveWslTranscriptPath(
  wslPath: string,
  agentSessionId: string,
  target: Partial<WslTarget> | undefined,
  opts: { platform?: NodeJS.Platform; shareRoot?: (distro: string) => string } = {},
): WslTranscriptResolution {
  if ((opts.platform ?? process.platform) !== 'win32') return { ok: false, reason: 'not a Windows host' };
  const distro = target?.distribution;
  // A trailing dot or space would name another share once Windows trims it.
  if (!isValidWslDistroName(distro) || win32AliasedName(distro) !== undefined) return { ok: false, reason: 'no valid distro' };
  if (!isWslOwnTranscriptPath(wslPath, agentSessionId, target)) return { ok: false, reason: 'not this pane\'s transcript' };
  if (/[:*?"<>|]/.test(wslPath) || win32AliasedName(wslPath) !== undefined) {
    return { ok: false, reason: 'a name Windows reads differently' };
  }
  const share = (opts.shareRoot ?? wslShareRoot)(distro);
  const segments = wslPath.split('/').filter(Boolean);
  // isWslOwnTranscriptPath pinned the shape: <home…>/.claude/projects/<project>/<file>.
  const file = path.join(share, ...segments);
  // The native realpath: it names a file as the filesystem spells it, so a
  // case variant on a case-insensitive disk does not pass as the path itself.
  const resolvesToItself = (p: string): boolean => sameSharePath(fs.realpathSync.native(p), p, share);
  try {
    if (!fs.lstatSync(file).isFile()) return { ok: false, reason: 'not a regular file' };
    if (!resolvesToItself(file)) return { ok: false, reason: 'outside the Claude projects root' };
    return { ok: true, hostPath: file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
  }
  const projectDir = path.dirname(file);
  try {
    if (!resolvesToItself(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      return { ok: false, reason: 'outside the Claude projects root' };
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, hostPath: file, pending: true };
}

/**
 * Is `resolved` (a realpath) the very path `lexical` names under `share`?
 * realpath hands the share prefix back as it was given (`\\wsl$\`,
 * `\\wsl.localhost\`, in the caller's case), and Windows matches the share
 * name without case, so only that prefix is compared without case. Below it
 * are Linux names, which are case-sensitive: the rest must match exactly.
 */
export function sameSharePath(resolved: string, lexical: string, share: string): boolean {
  return resolved.length === lexical.length
    && resolved.slice(0, share.length).toLowerCase() === share.toLowerCase()
    && lexical.slice(0, share.length).toLowerCase() === share.toLowerCase()
    && resolved.slice(share.length) === lexical.slice(share.length);
}
