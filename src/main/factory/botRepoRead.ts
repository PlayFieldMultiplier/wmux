// ─── Bot repository reading — Read, Grep and Glob inside the bot's repo ────
//
// A bot whose profile names a repository reads that checkout itself, so a
// "where is X defined?" needs no fan-out worker. The power is exactly three
// built-in tools of the Claude SDK engine — Read, Grep and Glob — and main
// decides every call (ClaudeSdkAdapter wires these into the session):
//   - every path a call names resolves (realpath, symlinks followed) inside
//     the repository root, and is not a protected file (BOT_REPO_SECRET_PATTERNS
//     matched against each path segment below the root);
//   - Grep and Glob without a path search the repository root; a Glob pattern
//     or a Grep file filter stays relative to the searched folder;
//   - Grep and Glob results leave protected files out (the session's Read deny
//     rules, `botRepoReadDenyRules`), and a Grep result that still names a
//     protected file is withheld whole (`grepOutputNamesProtected`);
//   - any other tool is not a read tool and is refused.
// A bot without a repository (or on another engine) has no built-in tools.

import fs from 'node:fs';
import path from 'node:path';
import type { BotProfile } from '../../shared/bot';

/** The built-in tools a repository-reading bot holds. Never Bash, Edit,
 *  Write, NotebookEdit, WebFetch, Task or Agent. */
export const BOT_REPO_READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Protected files and folders: matched, case-insensitively, against every
 *  path segment below the repository root (`*` = any run of characters). A
 *  folder entry protects everything under it. */
export const BOT_REPO_SECRET_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'credentials*',
  '.git',
  '.ssh',
];

const SECRET_MATCHERS = BOT_REPO_SECRET_PATTERNS.map((pattern) => ({
  pattern,
  re: new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'),
}));

/** The repository root a bot reads, or undefined: any bot on the claude-sdk
 *  engine whose profile names a repository, whatever its template. */
export function botRepoReadRoot(profile: Pick<BotProfile, 'engine' | 'repo'>): string | undefined {
  if (profile.engine.kind !== 'claude-sdk') return undefined;
  const root = profile.repo?.repoPath;
  return root && path.isAbsolute(root) ? root : undefined;
}

/** The protected pattern a path below the root hits (`rel` uses either
 *  separator), or null. */
export function protectedPatternOf(rel: string): string | null {
  for (const segment of rel.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    const hit = SECRET_MATCHERS.find((m) => m.re.test(segment));
    if (hit) return hit.pattern;
  }
  return null;
}

/** A path below `root`, relative to it, or null when `target` is outside. */
function relativeInside(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel;
}

/** A glob that stays relative: no absolute or home-relative start and no
 *  `..` segment (braces and lists included). */
function globStaysInside(glob: string): boolean {
  const g = glob.replace(/^!/, '');
  if (path.isAbsolute(g) || /^[\\/~]/.test(g) || /^[A-Za-z]:/.test(g)) return false;
  return !/(^|[\\/{,])\.\.([\\/},]|$)/.test(g);
}

export interface RepoReadDeps {
  realpath: (p: string) => string;
}

const defaultDeps: RepoReadDeps = { realpath: (p) => fs.realpathSync.native(p) };

export type RepoReadDecision =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; reason: string };

type PathCheck = { ok: true; real: string } | { ok: false; reason: string };

function checkPath(requested: string, root: string, realRoot: string, deps: RepoReadDeps): PathCheck {
  const lexical = path.resolve(root, requested);
  const lexicalRel = relativeInside(root, lexical) ?? relativeInside(realRoot, lexical);
  if (lexicalRel !== null) {
    const hit = protectedPatternOf(lexicalRel);
    if (hit) return { ok: false, reason: `${requested} is a protected file (${hit})` };
  }
  let real: string;
  try {
    real = deps.realpath(lexical);
  } catch {
    return { ok: false, reason: `${requested} does not exist` };
  }
  const realRel = relativeInside(realRoot, real);
  if (realRel === null) return { ok: false, reason: `${requested} is outside the repository` };
  const hit = protectedPatternOf(realRel);
  if (hit) return { ok: false, reason: `${requested} is a protected file (${hit})` };
  return { ok: true, real };
}

/**
 * Main's decision on one built-in tool call of a repository-reading bot.
 * Allowed calls come back with every path made absolute (the resolved real
 * path), and Grep / Glob without a path pointed at the root. Fails closed:
 * an unreadable root, a missing path or a malformed input is a refusal.
 */
export function evaluateBotRepoRead(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
  deps: RepoReadDeps = defaultDeps,
): RepoReadDecision {
  if (!BOT_REPO_READ_TOOLS.includes(toolName)) return { ok: false, reason: `${toolName} is not a repository read tool` };
  let realRoot: string;
  try {
    realRoot = deps.realpath(root);
  } catch {
    return { ok: false, reason: 'the repository folder is not readable' };
  }
  if (toolName === 'Read') {
    const file = input.file_path;
    if (typeof file !== 'string' || file.length === 0) return { ok: false, reason: 'Read needs a file_path' };
    const r = checkPath(file, root, realRoot, deps);
    return r.ok ? { ok: true, input: { ...input, file_path: r.real } } : r;
  }
  const requested = input.path;
  if (requested !== undefined && (typeof requested !== 'string' || requested.length === 0)) {
    return { ok: false, reason: `${toolName} path must be a folder or file path` };
  }
  const r = checkPath(typeof requested === 'string' ? requested : realRoot, root, realRoot, deps);
  if (!r.ok) return r;
  if (toolName === 'Glob') {
    if (typeof input.pattern !== 'string' || !globStaysInside(input.pattern)) {
      return { ok: false, reason: 'a Glob pattern must be relative to the searched folder' };
    }
  } else if (input.glob !== undefined) {
    if (typeof input.glob !== 'string' || !input.glob.split(/[\s,]+/).filter(Boolean).every(globStaysInside)) {
      return { ok: false, reason: 'a Grep glob must be relative to the searched folder' };
    }
  }
  return { ok: true, input: { ...input, path: r.real } };
}

/**
 * The session's Read deny rules for the protected patterns under `root`
 * (Claude Code permission-rule syntax, `//` = an absolute path). Besides
 * refusing Read, the CLI turns Read deny rules into exclusions for Grep and
 * Glob, so a search of the repository leaves protected files out of its
 * results.
 */
export function botRepoReadDenyRules(root: string, platform: NodeJS.Platform = process.platform): string[] {
  let base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32' && /^[A-Za-z]:/.test(base)) base = `/${base[0].toLowerCase()}${base.slice(2)}`;
  // The root is literal: a pattern character in it is escaped (gitignore syntax).
  base = base.replace(/[[\]*?{}]/g, (c) => `\\${c}`);
  return BOT_REPO_SECRET_PATTERNS.flatMap((p) => [`Read(/${base}/**/${p})`, `Read(/${base}/**/${p}/**)`]);
}

/**
 * The paths a Grep result names, checked against the protected patterns: a
 * result that names a protected path below the root is withheld whole.
 * `filenames` entries are paths; each `content` line starts with a path
 * followed by `:` (matches, counts) or `-` (context lines), so every prefix
 * of a line that ends before a `:` or a `-` counts. Whether that file still
 * exists does not matter; a line whose text happens to look like a
 * protected path withholds the result too (fail closed).
 */
export function grepOutputNamesProtected(response: unknown, root: string, realRoot: string = root): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as { filenames?: unknown; content?: unknown };
  const protectedPath = (candidate: string): boolean => {
    if (!candidate) return false;
    const abs = path.resolve(root, candidate);
    const rel = relativeInside(root, abs) ?? relativeInside(realRoot, abs);
    return rel !== null && protectedPatternOf(rel) !== null;
  };
  if (Array.isArray(r.filenames) && r.filenames.some((f) => typeof f === 'string' && protectedPath(f))) return true;
  if (typeof r.content !== 'string') return false;
  for (const line of r.content.split('\n')) {
    for (let i = 1; i < line.length; i++) {
      if ((line[i] === ':' || line[i] === '-') && protectedPath(line.slice(0, i))) return true;
    }
  }
  return false;
}
