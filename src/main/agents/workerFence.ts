// ─── The worker fence: the one settings file an unattended worker runs with ─
//
// An unattended claude worker (a bot preset in `bypassPermissions`, a fan-out
// worker in `auto`) runs with ONE `--settings` document that confines it to
// its worktree and its own temp folder:
//   - Claude Code's OS sandbox (Seatbelt on macOS, bubblewrap on Linux) for
//     Bash: writes only in the worktree, the worker's temp folder and the
//     repository's trusted test paths; the shared `.git` narrowed to what a
//     commit on the worker's own branch needs; the named credential files
//     unreadable;
//   - a PreToolUse hook (matcher `.*`) for claude's built-in file tools, which
//     run in claude's own process, outside the sandbox: a write lands only
//     inside the worktree or the temp folder (workerFenceHookScript);
//   - a permission deny on the same credential files, because the Read tool
//     does not go through the sandbox's denyRead.
// Where the sandbox cannot run (Windows, WSL, Linux without bubblewrap) the
// document carries the hook and the permission denies only, and says so
// (`weaker`).
//
// Everything here is pure: main computes the git facts and paths at launch
// and passes them in. Wiring it into a launch is the caller's job.

import os from 'node:os';
import path from 'node:path';
import { launcherStem, tokenize, type PermissionMode } from '../../shared/agentResume';
import { namesClaude, spliceSettingsFlag } from '../../shared/botWorkerGuard';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import { WORKER_FOLDER_CONFIG_NAMES } from '../connectors/workerGateway';
import { botSandboxDenyRead, type BotSandboxInput } from '../factory/botExecSandbox';
import { WORKER_GATE_TIMEOUT_S } from './workerToolGate';

// ── The credential set ───────────────────────────────────────────────────────

/**
 * The paths no fenced worker reads: the bot sandbox's named list
 * (botSandboxDenyRead), without the whole home folder (a worker works in it),
 * without GitHub's CLI config (a worker reads GitHub through `gh`), and with
 * each Claude config folder narrowed to its sign-in file (`.credentials.json`;
 * the rest, its shell snapshots included, is what the worker's own commands
 * read).
 */
export function workerFenceCredentialPaths(input: BotSandboxInput): string[] {
  const home = path.resolve(input.home ?? os.homedir());
  const claudeDirs = new Set(
    [path.join(home, '.claude'), input.env.CLAUDE_CONFIG_DIR, ...(input.accountConfigDirs ?? [])]
      .filter((d): d is string => typeof d === 'string' && path.isAbsolute(d))
      .map((d) => path.resolve(d)),
  );
  const gh = path.join(home, '.config', 'gh');
  const out = new Set<string>();
  for (const raw of botSandboxDenyRead({ ...input, home })) {
    const p = path.resolve(raw);
    if (p === home || p === gh) continue;
    if (path.basename(p) === 'shell-snapshots' && claudeDirs.has(path.dirname(p))) continue;
    out.add(claudeDirs.has(p) ? path.join(p, '.credentials.json') : p);
  }
  return [...out];
}

// ── The builder ──────────────────────────────────────────────────────────────

export interface WorkerFenceInput {
  /** The worker's worktree (absolute, real path). */
  worktree: string;
  /** The worker's own temp folder, made by main (absolute, real path). */
  workerTempDir: string;
  /** The repository's git common dir (absolute, real path). */
  gitCommonDir: string;
  /** The worktree is a linked one (`git worktree add`), not the main checkout. */
  isLinkedWorktree: boolean;
  /** A linked worktree's folder name under `<gitCommonDir>/worktrees/`; null
   *  for the main checkout. */
  ownWorktreeName: string | null;
  /** The worker's own branch (null when detached). */
  ownBranch: string | null;
  /** Every other local branch at launch. */
  otherBranches: readonly string[];
  /** Every other linked worktree's folder name under `<gitCommonDir>/worktrees/`. */
  otherWorktrees: readonly string[];
  /** Claude Code's sandbox runs here (platform tools and claude version). */
  platformCapable: boolean;
  /** Extra write paths the repository's trusted wmux.json names for its tests. */
  repoTestWritePaths: readonly string[];
  /** The worker's permission mode. */
  permissionMode: PermissionMode;
  /** The hook's command (workerFenceHookCommand). */
  hookCommand: string;
  /** The credential paths (workerFenceCredentialPaths). */
  credentialPaths: readonly string[];
  /** The owner's home folder (permission rules name paths in it by `~/`). */
  home: string;
}

export interface WorkerFence {
  /** The worker's settings document (before WorkerFenceLaunch merges in what
   *  the launch also needs). */
  settings: Record<string, unknown>;
  /** The sandbox is not part of it: only the hook and the permission denies. */
  weaker: boolean;
}

/** Domains the sandbox lets through without asking. The list is not strict:
 *  another domain is asked about (auto) or let through (bypass). */
export const WORKER_FENCE_ALLOWED_DOMAINS: readonly string[] = ['github.com', 'api.github.com', 'registry.npmjs.org'];

const FILE_RULE_TOOLS: readonly string[] = ['Read', 'Edit', 'Write'];

function requireAbsolute(what: string, p: string): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error(`worker fence: ${what} is not an absolute path`);
  return path.resolve(p);
}

/** A name that joins under a folder as itself: no separator, not `.`/`..`. */
function requireFolderName(what: string, name: string): string {
  if (typeof name !== 'string' || name.length === 0 || /[\\/\0]/.test(name) || name === '.' || name === '..') {
    throw new Error(`worker fence: ${what} ${JSON.stringify(name)} is not a folder name`);
  }
  return name;
}

/** A branch name that joins under `refs/heads/` as itself: no empty, `.` or
 *  `..` part, no backslash and no control character. Git refuses all of them,
 *  so a real branch always passes; anything else stops the build rather than
 *  leave a branch without its deny. */
function requireBranchPath(name: string): string[] {
  const parts = typeof name === 'string' ? name.split('/') : [];
  const control = [...(typeof name === 'string' ? name : '')].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (parts.length === 0 || control || name.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`worker fence: branch ${JSON.stringify(name)} cannot be named under refs/heads`);
  }
  return parts;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The paths in the git common dir the worker's commands may not write. What
 * a commit on its own branch writes (loose objects, its own ref, its own
 * index and HEAD, the logs) stays open; packs, every other ref, the main
 * checkout's HEAD, hooks, config and every other worktree's metadata do not.
 * A linked worktree also keeps off the main checkout's index; a main-checkout
 * worker needs its own. Each other branch is denied by its own ref file: a
 * deny on `refs/heads` would win over the worker's own ref inside it. Pure.
 */
export function workerFenceGitDenies(input: Pick<WorkerFenceInput, 'gitCommonDir' | 'isLinkedWorktree' | 'ownWorktreeName' | 'ownBranch' | 'otherBranches' | 'otherWorktrees'>): string[] {
  const git = requireAbsolute('the git common dir', input.gitCommonDir);
  let ownGitDir = git;
  if (input.isLinkedWorktree) {
    if (input.ownWorktreeName === null) throw new Error('worker fence: a linked worktree needs its folder name under worktrees/');
    ownGitDir = path.join(git, 'worktrees', requireFolderName('worktree', input.ownWorktreeName));
  }
  const out = new Set<string>([
    path.join(git, 'objects', 'pack'),
    path.join(git, 'packed-refs'),
    path.join(git, 'refs', 'remotes'),
    path.join(git, 'refs', 'tags'),
    path.join(git, 'HEAD'),
    path.join(git, 'hooks'),
    path.join(git, 'config'),
    path.join(ownGitDir, 'config.worktree'),
  ]);
  if (input.isLinkedWorktree) out.add(path.join(git, 'index'));
  for (const name of input.otherWorktrees) {
    if (name === input.ownWorktreeName) continue;
    out.add(path.join(git, 'worktrees', requireFolderName('worktree', name)));
  }
  for (const branch of input.otherBranches) {
    const parts = requireBranchPath(branch);
    if (branch === input.ownBranch) continue;
    out.add(path.join(git, 'refs', 'heads', ...parts));
  }
  return [...out];
}

/** A permission rule's path: `~/…` inside home, `//…` (from the root) else. */
function rulePath(p: string, home: string): string {
  const posix = (s: string) => s.split(path.sep).join('/');
  const rel = path.relative(home, p);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${posix(rel)}`;
  return `//${posix(p).replace(/^\/+/, '')}`;
}

/**
 * The permission denies on the credential set, for Read, Edit and Write, on
 * each path and everything under it. A path that holds one of the worker's
 * own folders is left out: a deny beats every allow, so it would close the
 * worktree itself to the file tools. Pure.
 */
export function workerFencePermissionDenies(credentialPaths: readonly string[], ownFolders: readonly string[], home: string): string[] {
  const homeAbs = requireAbsolute('home', home);
  const own = ownFolders.map((f) => path.resolve(f));
  const out = new Set<string>();
  for (const raw of credentialPaths) {
    const p = requireAbsolute('a credential path', raw);
    if (own.some((f) => isWithin(f, p))) continue;
    const target = rulePath(p, homeAbs);
    for (const tool of FILE_RULE_TOOLS) {
      out.add(`${tool}(${target})`);
      out.add(`${tool}(${target}/**)`);
    }
  }
  return [...out];
}

/** The fence's environment: claude's temp folder (TMPDIR and the sandbox's
 *  temp grant follow it) and the package caches, all in the worker's temp
 *  folder, so no cache in home is shared between workers. Pure. */
export function workerFenceEnv(workerTempDir: string): Record<string, string> {
  const tmp = requireAbsolute('the worker temp dir', workerTempDir);
  return {
    CLAUDE_CODE_TMPDIR: tmp,
    npm_config_cache: path.join(tmp, 'npm-cache'),
    PIP_CACHE_DIR: path.join(tmp, 'pip-cache'),
    CARGO_HOME: path.join(tmp, 'cargo-home'),
  };
}

/**
 * The worker's fence settings. On a capable platform: the sandbox, the
 * environment, the permission denies and the hook. Elsewhere: the permission
 * denies and the hook only, marked `weaker`. Throws when an input cannot be
 * turned into a rule (a relative path, a malformed name): the caller then
 * does not start the worker. Pure.
 */
export function buildWorkerFence(input: WorkerFenceInput): WorkerFence {
  const worktree = requireAbsolute('the worktree', input.worktree);
  const tmp = requireAbsolute('the worker temp dir', input.workerTempDir);
  const git = requireAbsolute('the git common dir', input.gitCommonDir);
  if (typeof input.hookCommand !== 'string' || input.hookCommand.trim() === '') throw new Error('worker fence: no hook command');
  const credentials = input.credentialPaths.map((p) => requireAbsolute('a credential path', p));
  const deny = workerFencePermissionDenies(credentials, [worktree, tmp, git], input.home);
  const hooks = {
    PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: input.hookCommand, timeout: WORKER_GATE_TIMEOUT_S }] }],
  };
  if (!input.platformCapable) {
    return { settings: { permissions: { deny }, disableAllHooks: false, hooks }, weaker: true };
  }
  const tests = input.repoTestWritePaths.map((p) => requireAbsolute('a test write path', p));
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    // Bypass presets have no other judge for a command; auto mode keeps its
    // own, as bot commands do (botExecSandbox.ts).
    autoAllowBashIfSandboxed: input.permissionMode === 'bypassPermissions',
    allowUnsandboxedCommands: false,
    enableWeakerNestedSandbox: false,
    // `gh` reaches GitHub only with it (measured on macOS).
    enableWeakerNetworkIsolation: true,
    filesystem: {
      allowWrite: [...new Set([worktree, tmp, ...tests])],
      denyWrite: workerFenceGitDenies(input),
      denyRead: credentials,
      // Re-opened should a denied folder hold them (wmux keeps worktrees in
      // its home folder).
      allowRead: [...new Set([worktree, tmp, git])],
    },
    network: {
      allowedDomains: [...WORKER_FENCE_ALLOWED_DOMAINS],
      strictAllowlist: false,
      // Test runners listen on local ports and sockets in their temp folder.
      allowLocalBinding: true,
      allowUnixSockets: [...new Set([tmp, ...tests])],
    },
  };
  return {
    settings: { env: workerFenceEnv(tmp), permissions: { deny }, sandbox, disableAllHooks: false, hooks },
    weaker: false,
  };
}

// ── The launch: one settings file on one plain claude line ──────────────────

export type WorkerFenceRefusal = 'not-claude' | 'wrapper' | 'settings-flag' | 'unspliceable' | 'conflict';

export type WorkerFenceLaunch =
  | { ok: true; line: string; settings: Record<string, unknown> }
  | { ok: false; refusal: WorkerFenceRefusal; reason: string };

/** Programs that run another program: a line starting with one starts claude
 *  (if at all) where the fence's flag cannot be put. */
const WRAPPER_STEMS: ReadonlySet<string> = new Set([
  'env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox',
  'exec', 'command', 'builtin', 'eval', 'source', '.', 'nohup', 'nice', 'sudo', 'doas', 'su', 'time', 'timeout',
  'stdbuf', 'xargs', 'script', 'caffeinate', 'npx', 'bunx', 'pnpx', 'cmd', 'powershell', 'pwsh', 'wsl',
]);

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `src` into `dst`: objects key by key, arrays as a union (`dst`'s
 *  items first), equal values kept. Returns the first key two values disagree
 *  on, else null. */
function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown>, at: string): string | null {
  for (const [k, v] of Object.entries(src)) {
    const key = at ? `${at}.${k}` : k;
    if (UNSAFE_KEYS.has(k)) return key;
    if (!Object.prototype.hasOwnProperty.call(dst, k)) {
      dst[k] = structuredClone(v);
      continue;
    }
    const d = dst[k];
    if (Array.isArray(d) && Array.isArray(v)) {
      const seen = new Set(d.map((x) => JSON.stringify(x)));
      for (const item of v) {
        const s = JSON.stringify(item);
        if (!seen.has(s)) {
          seen.add(s);
          d.push(structuredClone(item));
        }
      }
      continue;
    }
    if (isPlainObject(d) && isPlainObject(v)) {
      const clash = mergeInto(d, v, key);
      if (clash) return clash;
      continue;
    }
    if (JSON.stringify(d) !== JSON.stringify(v)) return key;
  }
  return null;
}

/**
 * The fence merged with what the launch also needs (a WSL pane's hooks,
 * wslClaudeHooks; the bot worker's deny rules; wmux's status hooks). The
 * fence's own hook stays the first PreToolUse group. An extra may add, never
 * change: a `sandbox` of its own, or any value that differs from the
 * fence's (`disableAllHooks: true`, another CLAUDE_CODE_TMPDIR), is a
 * conflict. Pure.
 */
export function mergeWorkerFenceSettings(fence: Record<string, unknown>, extras: readonly Record<string, unknown>[]): { ok: true; settings: Record<string, unknown> } | { ok: false; key: string } {
  const out = structuredClone(fence);
  for (const extra of extras) {
    if (Object.prototype.hasOwnProperty.call(extra, 'sandbox')) return { ok: false, key: 'sandbox' };
    const clash = mergeInto(out, extra, '');
    if (clash) return { ok: false, key: clash };
  }
  return { ok: true, settings: out };
}

function refuse(refusal: WorkerFenceRefusal, reason: string): WorkerFenceLaunch {
  return { ok: false, refusal, reason };
}

/**
 * A fenced launch: the line with `--settings="<settingsPath>"` after its
 * claude launcher, and the settings that file must hold. Refused, with the
 * reason, when the fence cannot be attached to the line: it does not start
 * claude itself, it starts it through a wrapper (`env …`, `sh -c …`, a
 * variable assignment), it already carries a `--settings` (of two, the last
 * one wins), it is not one plain command spliceSettingsFlag can carry, or an
 * extra conflicts with the fence. Pure.
 */
export function workerFenceLaunch(input: {
  line: string;
  settingsPath: string;
  fence: Record<string, unknown>;
  extras?: readonly Record<string, unknown>[];
}): WorkerFenceLaunch {
  const { command } = splitModelEnvMarker(input.line);
  const tokens = tokenize(command);
  const first = tokens[0]?.value ?? '';
  const stem = launcherStem(first);
  if (stem !== 'claude') {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPER_STEMS.has(stem) || namesClaude(command)) {
      return refuse('wrapper', 'the line starts claude through another program, where the fence cannot be attached');
    }
    return refuse('not-claude', 'the line does not start claude');
  }
  const spliced = spliceSettingsFlag(input.line, input.settingsPath);
  if (tokens.slice(1).some((t) => /^--settings(=|$)/.test(t.value)) && spliced !== input.line) {
    return refuse('settings-flag', 'the line already carries its own --settings, which would replace the fence');
  }
  if (spliced === null) return refuse('unspliceable', 'the line is not one plain claude command the fence can be attached to');
  const merged = mergeWorkerFenceSettings(input.fence, input.extras ?? []);
  if (!merged.ok) return refuse('conflict', `the launch's other settings change the fence's ${merged.key}`);
  return { ok: true, line: spliced, settings: merged.settings };
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** The built-in tools whose target the hook checks. */
export const WORKER_FENCE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Built-in tools that pass whatever path they name: reads (not fenced) and
 *  the shells (the sandbox decides what their commands reach). */
export const WORKER_FENCE_PASS_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'PowerShell'];

/** Built-in tools that change files from claude's own process with no path
 *  the hook can check: they create or remove a git worktree. */
export const WORKER_FENCE_REFUSED_TOOLS: readonly string[] = ['EnterWorktree', 'ExitWorktree'];

/** The tool-input fields that name a file. */
export const WORKER_FENCE_PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/** How long the hook waits for its input before it refuses; well under the
 *  hook's timeout (WORKER_GATE_TIMEOUT_S), past which claude runs the call. */
export const WORKER_FENCE_INPUT_TIMEOUT_MS = 10_000;

/**
 * The hook script: plain JavaScript, the same for every worker (its roots
 * come on its command line), so main writes it once, content-named. It reads
 * the call as JSON on stdin and exits 0 to let it run or 2 to refuse it; any
 * other exit would let the call run, so every error, malformed input, missing
 * root or late input exits 2.
 *
 * For each call:
 *   - an MCP tool, or a built-in in WORKER_FENCE_PASS_TOOLS, passes;
 *   - a built-in in WORKER_FENCE_REFUSED_TOOLS is refused;
 *   - a write tool (WORKER_FENCE_WRITE_TOOLS) passes only when every path it
 *     names passes the check below;
 *   - any other tool passes when it names no path, and is refused when it
 *     does (a file tool the fence does not know).
 * A path passes when it is absolute with no `.`/`..` part, its real location
 * (that of its nearest existing parent, for a new file) is inside one of the
 * roots, it is not this script, it is not a file with more than one hard
 * link, and, inside the worktree (the first root), no part of it is `.git`
 * or `.claude` and its name is not `.mcp.json` or `CLAUDE*.md` (claude's own
 * configuration in the worker's folder). Pure.
 */
export function workerFenceHookScript(): string {
  const data = {
    write: WORKER_FENCE_WRITE_TOOLS,
    pass: WORKER_FENCE_PASS_TOOLS,
    refused: WORKER_FENCE_REFUSED_TOOLS,
    fields: WORKER_FENCE_PATH_FIELDS,
    configNames: ['.git', ...WORKER_FOLDER_CONFIG_NAMES].map((n) => n.toLowerCase()),
    timeoutMs: WORKER_FENCE_INPUT_TIMEOUT_MS,
    maxInput: 64 * 1024 * 1024,
  };
  return `'use strict';
// wmux: the worker fence's hook (generated). Argv: the roots, the worktree first.
const P = ${JSON.stringify(data)};
function refuse(msg) {
  try { process.stderr.write('wmux fence: ' + msg + '\\n'); } catch (e) { /* still refused */ }
  process.exit(2);
}
process.on('uncaughtException', (e) => refuse('hook error (' + (e && e.message) + '); call refused'));
process.on('unhandledRejection', (e) => refuse('hook error (' + (e && e.message) + '); call refused'));
const timer = setTimeout(() => refuse('the call did not arrive in time; call refused'), P.timeoutMs);
try {
  const fs = require('fs');
  const path = require('path');
  const self = fs.realpathSync.native(__filename);
  const args = process.argv.slice(2);
  if (args.length === 0) refuse('no fence roots; call refused');
  const roots = args.map((r) => {
    if (!path.isAbsolute(r)) refuse('fence root ' + r + ' is not absolute; call refused');
    const real = fs.realpathSync.native(r);
    if (!fs.statSync(real).isDirectory()) refuse('fence root ' + r + ' is not a folder; call refused');
    return real;
  });
  const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  // The real location of the nearest entry that exists (lstat sees a dangling
  // link too, whose realpath then throws), with the missing parts after it.
  const resolveReal = (abs) => {
    let p = abs;
    const rest = [];
    for (;;) {
      try { fs.lstatSync(p); break; } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
        const parent = path.dirname(p);
        if (parent === p) throw new Error('no existing parent');
        rest.unshift(path.basename(p));
        p = parent;
      }
    }
    return { real: path.join(fs.realpathSync.native(p), ...rest), existing: rest.length === 0 };
  };
  const check = (tool, target) => {
    if (typeof target !== 'string' || target.length === 0 || target.includes('\\0')) refuse(tool + ' names no usable path; call refused');
    if (!path.isAbsolute(target)) refuse(tool + ' to ' + target + ' is not an absolute path; call refused');
    if (target.split(/[\\\\/]+/).some((s) => s === '.' || s === '..')) refuse(tool + ' to ' + target + ' has a . or .. part; name the path itself');
    const { real, existing } = resolveReal(target);
    if (real === self) refuse(tool + ' to the fence hook itself; call refused');
    if (existing) {
      const st = fs.statSync(real);
      if (!st.isDirectory() && st.nlink > 1) refuse(tool + ' to ' + real + ' is a hard-linked file; call refused');
    }
    const root = roots.find((r) => within(real, r));
    if (!root) refuse(tool + ' to ' + real + ' is outside the worktree; write inside it instead');
    if (within(real, roots[0])) {
      const parts = path.relative(roots[0], real).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
      if (parts.some((s) => P.configNames.includes(s) || /^claude.*\\.md$/.test(s))) {
        refuse(tool + ' to ' + real + ' changes git or Claude configuration in the worktree; call refused');
      }
    }
  };
  const decide = (ev) => {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) refuse('the call is not an object; call refused');
    const tool = ev.tool_name;
    if (typeof tool !== 'string' || tool.length === 0) refuse('the call names no tool; call refused');
    if (tool.startsWith('mcp__') || P.pass.includes(tool)) process.exit(0);
    if (P.refused.includes(tool)) refuse(tool + ' is not available inside the worker fence');
    const input = ev.tool_input;
    const named = input && typeof input === 'object' ? P.fields.filter((f) => input[f] !== undefined) : [];
    if (!P.write.includes(tool)) {
      if (named.length === 0) process.exit(0);
      refuse(tool + ' is a file tool the worker fence does not know; call refused');
    }
    if (named.length === 0) refuse(tool + ' names no path; call refused');
    for (const f of named) check(tool, input[f]);
    process.exit(0);
  };
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', (e) => refuse('the call could not be read (' + e.message + '); call refused'));
  process.stdin.on('data', (d) => {
    raw += d;
    if (raw.length > P.maxInput) refuse('the call is too large; call refused');
  });
  process.stdin.on('end', () => {
    clearTimeout(timer);
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { refuse('the call is not JSON; call refused'); }
    decide(ev);
  });
} catch (e) {
  refuse('hook error (' + (e && e.message) + '); call refused');
}
`;
}

/** The hook's command: this process's runtime by its absolute path, as
 *  node, the script, then the roots (the worktree first, then the worker's
 *  temp folder). Null when any path cannot be quoted safely
 *  (workerToolGateCommand's rule) or there is no root. Pure. */
export function workerFenceHookCommand(runtime: string, script: string, roots: readonly string[]): string | null {
  const plain = (p: string) => /^\/[A-Za-z0-9._/ -]+$/.test(p);
  if (roots.length === 0 || ![runtime, script, ...roots].every(plain)) return null;
  return `ELECTRON_RUN_AS_NODE=1 "${runtime}" "${script}" ${roots.map((r) => `"${r}"`).join(' ')} || exit 2`;
}
