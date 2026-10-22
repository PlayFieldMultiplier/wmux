// ─── Bot repository git reads — git_show and git_diff in the bot's repo ────
//
// A repository-reading bot (botRepoRead.ts) reads the checkout as it stands,
// but `.git` is protected and a worker's worktree is outside the repository,
// so a commit it has not checked out was unreadable: a reviewer waited for a
// worker to report a SHA and then fanned out another worker just to read it.
// Worktrees share the repository's object store, so every commit a worker
// made is already readable from the repository root. These two tools read
// it, and nothing else:
//   git_show(rev, path)          one file (or folder listing) at a commit;
//   git_diff(base, head, paths?) name-status plus a patch of what head
//                                changed since it left base (base...head).
// Main runs git itself, with a fixed argv and no shell, in the bot's
// repository root (the same root botRepoReadRoot gives Read, Grep and Glob):
//   - a rev is a 7–40 hex SHA or a plain ref name (no option, no `..`, no
//     `@{`, no `^`/`~`/`:` suffix); anything else is refused;
//   - a path is relative to the root, never an option, never absolute, with
//     no `.`/`..`/empty segment, and never a protected file
//     (BOT_REPO_SECRET_PATTERNS): its content is not shown at any commit;
//   - each pathspec is `:(literal)`, protected files changed in a diff are
//     named but excluded from the patch (`:(exclude,literal)`);
//   - git runs through repoGitRead (the repository config may set no
//     content filter and no partial clone, so no read fetches), with no
//     external diff, no textconv and a submodule shown as one line;
//   - output is capped (BOT_REPO_GIT_OUTPUT_MAX characters).
// The tools are an in-process MCP server of the bot's own SDK session
// (botRepoGitServer.ts, held by ClaudeSdkAdapter), never on the wmux MCP
// surface: they are decided per call by main like the built-in read tools,
// and refused in a wake not known clean of a guest's words like them (their
// names do not start with mcp__wmux__, so the guest gate refuses them; the
// handler checks again).

import { git } from '../git/git';
import { workerGitPreflight } from '../worktask/workerGit';
import { protectedPatternOf } from './botRepoRead';

/** The in-process MCP server's name; its tools are mcp__wmux_repo__<tool>. */
export const BOT_REPO_GIT_SERVER = 'wmux_repo';

export const BOT_REPO_GIT_TOOLS: readonly string[] = ['git_show', 'git_diff'];

/** The session's name for one of the tools. */
export function botRepoGitToolName(tool: string): string {
  return `mcp__${BOT_REPO_GIT_SERVER}__${tool}`;
}

/** Whether a session tool name is one of these tools. */
export function isBotRepoGitTool(toolName: string): boolean {
  return BOT_REPO_GIT_TOOLS.some((t) => botRepoGitToolName(t) === toolName);
}

/** The session's line on the tools (the role prompts name the wmux tools only). */
export const BOT_REPO_GIT_PROMPT =
  `Your repository's commits: ${botRepoGitToolName('git_show')} reads a file at a commit and ${botRepoGitToolName('git_diff')} shows what a head changed since its base, `
  + 'by SHA or ref name. Every commit a worker makes in its worktree is readable with them as soon as it is committed, so read a worker\'s change there yourself.';

/** Most characters one call returns. */
export const BOT_REPO_GIT_OUTPUT_MAX = 100_000;
/** Most paths one git_diff names. */
export const BOT_REPO_GIT_PATHS_MAX = 50;
/** Largest file git_show reads (larger ones are reported by size). */
const BLOB_READ_MAX = 8 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Why `rev` is not a rev these tools take, or null. Pure. */
export function revRefusal(rev: unknown): string | null {
  if (typeof rev !== 'string' || rev.length === 0) return 'a rev is required';
  const shown = JSON.stringify(rev.slice(0, 80));
  if (rev.startsWith('-')) return `rev ${shown} looks like an option`;
  if (SHA_RE.test(rev)) return null;
  if (!REF_RE.test(rev) || rev.includes('..') || rev.includes('//') || rev.endsWith('/') || rev.endsWith('.') || rev.endsWith('.lock')) {
    return `rev ${shown} is not a commit SHA (7-40 hex) or a plain ref name`;
  }
  return null;
}

/** Why `p` is not a repository path these tools take, or null. Pure. */
export function pathRefusal(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'a path is required';
  const shown = JSON.stringify(p.slice(0, 120));
  if (p.length > 1000 || p.includes('\0')) return `path ${shown} is not a repository path`;
  if (p.startsWith('-')) return `path ${shown} looks like an option`;
  if (p.startsWith('/') || p.startsWith('~') || p.startsWith(':') || p.includes('\\') || /^[A-Za-z]:/.test(p)) {
    return `path ${shown} must be relative to the repository root`;
  }
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return `path ${shown} must name a path inside the repository (no ".", ".." or empty segment)`;
  const hit = protectedPatternOf(p);
  return hit ? `${p} is a protected file (${hit})` : null;
}

export type GitRead = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Config that makes a read fetch: a partial clone fetches a missing object
 *  from its promisor remote, through whatever transport config names. */
const LAZY_FETCH_KEY = /^(?:extensions\.partialclone|remote\..+\.promisor)$/;

/** Main's git for these reads: the repository config may set no content
 *  filter (runWorkerGitRead's check) and make no read fetch. Never throws. */
export async function repoGitRead(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = (a: string[]) => git(a, cwd);
  const pre = await workerGitPreflight(run, 'read');
  if (!pre.ok) return { stdout: '', stderr: pre.error, code: 1 };
  const lazy = pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && LAZY_FETCH_KEY.test(e.key));
  if (lazy) return { stdout: '', stderr: `the repository's git config sets ${lazy.key} (a partial clone): these reads never fetch`, code: 1 };
  return run(args);
}

export type GitToolResult = { ok: true; text: string } | { ok: false; reason: string };

const cap = (text: string): string => (text.length > BOT_REPO_GIT_OUTPUT_MAX
  ? `${text.slice(0, BOT_REPO_GIT_OUTPUT_MAX)}\n[output cut at ${BOT_REPO_GIT_OUTPUT_MAX} characters]`
  : text);

const errText = (r: { stderr: string }): string => r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';

/** The commit a rev names in the repository's object store, resolved once
 *  (every later git call of the tool uses this SHA, so a ref that moves
 *  meanwhile changes nothing), or the reason it names none. */
async function resolveCommit(root: string, rev: string, run: GitRead): Promise<{ sha: string } | { reason: string }> {
  const r = await run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], root);
  const sha = r.stdout.trim();
  if (r.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { sha };
  // The config check refused before git ran: say why.
  if (r.stderr.startsWith('the repository\'s git config')) return { reason: r.stderr.slice(0, 300) };
  return { reason: `${rev} is not a commit in this repository's object store (a branch or pull request that was never fetched here is not; a verify worker fetches it)` };
}

/** git_show: one file at a commit, or the listing of a folder there. */
export async function gitShow(root: string, input: { rev?: unknown; path?: unknown }, run: GitRead = repoGitRead): Promise<GitToolResult> {
  const bad = revRefusal(input.rev) ?? pathRefusal(input.path);
  if (bad) return { ok: false, reason: bad };
  const rev = input.rev as string;
  const file = input.path as string;
  const commit = await resolveCommit(root, rev, run);
  if ('reason' in commit) return { ok: false, reason: commit.reason };
  const object = `${commit.sha}:${file}`;
  const type = await run(['cat-file', '-t', object], root);
  if (type.code !== 0) return { ok: false, reason: `${file} does not exist at ${rev}` };
  const kind = type.stdout.trim();
  if (kind === 'tree') {
    const ls = await run(['ls-tree', '--name-only', '-z', object], root);
    if (ls.code !== 0) return { ok: false, reason: `the folder ${file} at ${rev} could not be listed: ${errText(ls)}` };
    const names = ls.stdout.split('\0').filter(Boolean).filter((n) => protectedPatternOf(n) === null);
    return { ok: true, text: cap(`${rev}:${file} at ${commit.sha} (folder)\n${names.join('\n')}`) };
  }
  if (kind !== 'blob') return { ok: false, reason: `${file} at ${rev} is a ${kind || 'non-file object'}, not a file` };
  const size = await run(['cat-file', '-s', object], root);
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (size.code !== 0 || !Number.isSafeInteger(bytes)) return { ok: false, reason: `${file} at ${rev} could not be read` };
  const shown = `${rev}:${file} at ${commit.sha}`;
  if (bytes > BLOB_READ_MAX) return { ok: true, text: `${shown} (${bytes} bytes): too large to show` };
  const blob = await run(['cat-file', 'blob', object], root);
  if (blob.code !== 0) return { ok: false, reason: `${file} at ${rev} could not be read: ${errText(blob)}` };
  if (blob.stdout.slice(0, 8000).includes('\0')) return { ok: true, text: `${shown} (${bytes} bytes): a binary file` };
  return { ok: true, text: cap(`${shown} (${bytes} bytes)\n${blob.stdout}`) };
}

/** git_diff: what head changed since it left base (base...head), as
 *  name-status rows and a patch, for every path or only `paths`. */
export async function gitDiff(
  root: string,
  input: { base?: unknown; head?: unknown; paths?: unknown },
  run: GitRead = repoGitRead,
): Promise<GitToolResult> {
  const badRev = revRefusal(input.base) ?? revRefusal(input.head);
  if (badRev) return { ok: false, reason: badRev };
  const paths = input.paths === undefined ? [] : input.paths;
  if (!Array.isArray(paths) || paths.length > BOT_REPO_GIT_PATHS_MAX) return { ok: false, reason: `paths must be a list of at most ${BOT_REPO_GIT_PATHS_MAX} repository paths` };
  for (const p of paths) {
    const bad = pathRefusal(p);
    if (bad) return { ok: false, reason: bad };
  }
  const base = input.base as string;
  const head = input.head as string;
  // Each rev resolved once: the name-status run and the patch run read the
  // same two commits.
  const b = await resolveCommit(root, base, run);
  if ('reason' in b) return { ok: false, reason: b.reason };
  const h = await resolveCommit(root, head, run);
  if ('reason' in h) return { ok: false, reason: h.reason };
  const range = `${b.sha}...${h.sha}`;
  // A submodule is one line, never its files' diff (diff.submodule=diff
  // would show files inside it that no protected-path check sees).
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short'];
  const scope = (paths as string[]).map((p) => `:(literal)${p}`);
  const names = await run(['diff', ...flags, '--name-status', '-z', range, '--', ...scope], root);
  if (names.code !== 0) return { ok: false, reason: `git diff ${range} failed: ${errText(names)}` };
  const parts = names.stdout.split('\0');
  const rows: Array<{ status: string; file: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) rows.push({ status: parts[i], file: parts[i + 1] });
  const hidden = rows.filter((r) => protectedPatternOf(r.file) !== null);
  const lines = rows.map((r) => `${r.status}\t${r.file}${protectedPatternOf(r.file) !== null ? '  (protected: not shown)' : ''}`);
  const head1 = `${base}...${head} (${range}): ${rows.length} file${rows.length === 1 ? '' : 's'} changed\n${lines.join('\n')}`;
  if (rows.length === hidden.length) return { ok: true, text: cap(head1) };
  const exclude = [...new Set(hidden.map((r) => `:(exclude,literal)${r.file}`))];
  const patch = await run(['diff', ...flags, range, '--', ...(scope.length > 0 ? scope : ['.']), ...exclude], root);
  // Past git's output buffer the run fails with what it had read: the cap cuts it.
  if (patch.code !== 0 && patch.stdout.length <= BOT_REPO_GIT_OUTPUT_MAX) return { ok: false, reason: `git diff ${range} failed: ${errText(patch)}` };
  return { ok: true, text: cap(`${head1}\n\n${patch.stdout}`) };
}
