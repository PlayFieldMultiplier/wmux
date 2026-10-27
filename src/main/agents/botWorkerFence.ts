// ─── The worker fence on a bot's worker launch ─────────────────────────────
//
// What main does to put an unattended bot worker inside the worker fence
// (workerFence.ts) when it launches it (botWorkerMergeGuard.ts):
//
//   - which launches are fenced: a claude line in `bypassPermissions` or
//     `auto` mode, unless the owner turned the fence off for the bot's
//     workspace (workerFencePolicy.ts) and the session did not start fenced;
//   - how strong: on a platform whose OS sandbox claude can run (macOS;
//     Linux with bwrap and socat; claude at or above
//     BOT_EXEC_MIN_CLAUDE_VERSION, probeBotExecSupport) the full fence, once a
//     self-test proved it (below). Elsewhere (Windows, Linux without
//     bubblewrap) the weaker fence: the hook and the permission denies, and a
//     "weaker fence" line in the pane's status line. A WSL pane gets the
//     permission denies only (its claude runs inside the distro, where this
//     build's hook runtime does not), and says so the same way;
//   - the facts the fence is built from: the worktree's git layout, read from
//     its files (and checked against the task ledger's), its own temp folder,
//     and the credential paths;
//   - what refuses the launch: a worktree whose `.claude`, `.claude/settings*`
//     or `.mcp.json` is a link out of the worktree, project settings that
//     would loosen the fence, and every refusal of workerFenceLaunch.
//
// The self-test (one per app session, platform and claude binary): claude
// runs one Bash command, scripted by a local stand-in for the Messages API,
// inside a fence built the same way, and that command tries to write a file
// outside the fence's writable folders. It passes only when the command ran
// and the file was not written. A claude that fails it starts its workers
// with no tools (every call refused), and the pane's status line says why.
// No model and no sign-in are used: the stand-in answers on 127.0.0.1, and
// claude runs with a home and config folder of its own.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tokenize, type PermissionMode } from '../../shared/agentResume';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import { contentFileName } from '../../shared/botWorkerMcp';
import { getWmuxDir } from '../../daemon/config';
import { resolveClaudeExecutable } from '../claude/resolveClaudeExecutable';
import { probeBotExecSupport } from '../factory/botExecSandbox';
import {
  WORKER_FENCE_FILE_ALLOW_RULE,
  WORKER_FENCE_REFUSED_PERMISSION_KEYS,
  WORKER_FENCE_REFUSED_SETTINGS_KEYS,
  buildWorkerFence,
  workerFenceCredentialPaths,
  workerFenceHookCommand,
  workerFenceHookScript,
  workerFencePermissionDenies,
} from './workerFence';

// ── Which launches ───────────────────────────────────────────────────────────

/** The permission mode a launch line starts claude in, from its flags,
 *  wherever they are: quoted words and the words inside them count too (a
 *  wrapper's `sh -c "claude …"`), so a line that may run unattended is
 *  never taken for one that does not. Undefined: none named. */
export function linePermissionMode(line: string): PermissionMode | undefined {
  const words = tokenize(splitModelEnvMarker(line).command).flatMap((t) => t.value.split(/\s+/)).filter(Boolean);
  let mode: PermissionMode | undefined;
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    if (v === '--dangerously-skip-permissions' || v === '--allow-dangerously-skip-permissions') mode = 'bypassPermissions';
    const named = v === '--permission-mode' ? words[i + 1] : v.startsWith('--permission-mode=') ? v.slice('--permission-mode='.length) : undefined;
    if (named !== undefined) mode = (['bypassPermissions', 'acceptEdits', 'plan', 'auto', 'default'] as const).find((m) => m === named) ?? mode;
  }
  return mode;
}

/** The modes an unattended worker runs in: the fence is for them. */
export function isFencedMode(mode: PermissionMode | undefined): boolean {
  return mode === 'bypassPermissions' || mode === 'auto';
}

// ── Platform support and the self-test ──────────────────────────────────────

export type WorkerFenceSelfTest = { ok: true } | { ok: false; reason: string };

export type WorkerFenceSupport =
  | { capable: false; reason: string }
  | { capable: true; exe: string; version: string; selfTest: WorkerFenceSelfTest };

export interface WorkerFenceSupportDeps {
  /** The claude binary workers run (default: resolveClaudeExecutable). */
  exe?: () => string | null;
  probe?: typeof probeBotExecSupport;
  selfTest?: (exe: string) => Promise<WorkerFenceSelfTest>;
  platform?: NodeJS.Platform;
}

let lastSupport: WorkerFenceSupport | null = null;
const passed = new Set<string>();
const running = new Map<string, Promise<WorkerFenceSelfTest>>();

/**
 * Whether this computer runs the full fence, and with which claude: the
 * platform and version check bots' commands use, then the self-test (a pass
 * is kept for the app session, per platform, binary and version; a failure
 * is tried again on the next launch). Never throws.
 */
export async function workerFenceSupport(deps: WorkerFenceSupportDeps = {}): Promise<WorkerFenceSupport> {
  const platform = deps.platform ?? process.platform;
  let exe: string | null = null;
  try {
    exe = (deps.exe ?? resolveClaudeExecutable)();
  } catch {
    exe = null;
  }
  const support = await (deps.probe ?? probeBotExecSupport)(exe, { platform });
  if (!support.ok || !exe) {
    lastSupport = { capable: false, reason: support.ok ? 'no claude executable' : support.reason };
    return lastSupport;
  }
  const key = `${platform}\0${exe}\0${support.version}`;
  let selfTest: WorkerFenceSelfTest = { ok: true };
  if (!passed.has(key)) {
    let run = running.get(key);
    if (!run) {
      run = (deps.selfTest ?? ((e: string) => runWorkerFenceSelfTest(e)))(exe).catch((err) => ({ ok: false as const, reason: `the self-test could not run: ${String(err)}` }));
      running.set(key, run);
    }
    try {
      selfTest = await run;
    } finally {
      running.delete(key);
    }
    if (selfTest.ok) passed.add(key);
  }
  lastSupport = { capable: true, exe, version: support.version, selfTest };
  return lastSupport;
}

/** The last answer of workerFenceSupport (null before the first). */
export function lastWorkerFenceSupport(): WorkerFenceSupport | null {
  return lastSupport;
}

/** Test-only. */
export function __resetWorkerFenceSupportForTesting(): void {
  lastSupport = null;
  passed.clear();
  running.clear();
}

/** How long the self-test's claude may take, start to end. */
export const WORKER_FENCE_SELF_TEST_TIMEOUT_MS = 45_000;

function shSingle(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** A local stand-in for the Messages API: the first request that offers the
 *  Bash tool gets one Bash call running `command`; every other request gets
 *  a short text answer that ends the turn. */
function startScriptedApi(command: string): Promise<{ url: string; close: () => void }> {
  const event = (res: http.ServerResponse, type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let called = false;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      if (body.length < 8 * 1024 * 1024) body += d;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method !== 'POST' || !url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      let tools: Array<{ name?: unknown }> = [];
      try {
        const parsed = JSON.parse(body) as { tools?: unknown };
        if (Array.isArray(parsed.tools)) tools = parsed.tools as Array<{ name?: unknown }>;
      } catch {
        /* a text answer */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      n += 1;
      event(res, 'message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'wmux-fence-self-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      const callBash = !called && tools.some((t) => t.name === 'Bash');
      if (callBash) {
        called = true;
        event(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_wmux_fence', name: 'Bash', input: {} } });
        event(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'wmux fence self-test' }) } });
      } else {
        event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } });
      }
      event(res, 'content_block_stop', { index: 0 });
      event(res, 'message_delta', { delta: { stop_reason: callBash ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event(res, 'message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('the stand-in API did not get a port'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

export interface WorkerFenceSelfTestOptions {
  /** The data folder the test's files go under (default: getWmuxDir()). */
  dir?: string;
  /** The hook's runtime (default: this process's). */
  runtime?: string;
  timeoutMs?: number;
}

/**
 * The self-test (see the file header). Resolves with why it failed, never
 * rejects. Its files go under `<dir>/factory/fence-self-test/` and are removed
 * once it ends.
 */
export async function runWorkerFenceSelfTest(exe: string, opts: WorkerFenceSelfTestOptions = {}): Promise<WorkerFenceSelfTest> {
  const dir = opts.dir ?? getWmuxDir();
  const base = path.join(dir, 'factory', 'fence-self-test');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'run-')));
  const sub = (name: string) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { mode: 0o700 });
    return p;
  };
  const wt = sub('wt');
  const tmp = sub('tmp');
  const git = sub('git');
  const home = sub('home');
  const config = sub('config');
  const ran = path.join(wt, 'ran');
  const canary = path.join(root, 'canary');
  let api: { url: string; close: () => void } | null = null;
  try {
    const script = writeWorkerFenceHookScript(dir);
    const hookCommand = workerFenceHookCommand(opts.runtime ?? process.execPath, script, [wt, tmp]);
    if (!hookCommand) return { ok: false, reason: 'the fence hook\'s command cannot be written for this runtime' };
    const fence = buildWorkerFence({
      worktree: wt, workerTempDir: tmp, gitCommonDir: git, isLinkedWorktree: false, ownWorktreeName: null, ownBranch: null,
      otherBranches: [], otherWorktrees: [], platformCapable: true, repoTestWritePaths: [], permissionMode: 'bypassPermissions',
      hookCommand, credentialPaths: [], home,
    });
    const settingsFile = path.join(root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(fence.settings), { mode: 0o600 });
    api = await startScriptedApi(`touch ${shSingle(ran)}; touch ${shSingle(canary)}`);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_TMPDIR: tmp,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'wmux-fence-self-test',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    const args = ['-p', 'wmux fence self-test', '--dangerously-skip-permissions', '--setting-sources', 'project', '--settings', settingsFile,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '2', '--output-format', 'json'];
    const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      const child = spawn(exe, args, { cwd: wt, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? WORKER_FENCE_SELF_TEST_TIMEOUT_MS);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        if (stderr.length < 4096) stderr += d;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, stderr: String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
    if (fs.existsSync(canary)) return { ok: false, reason: 'a command wrote outside the fence\'s folders, so the OS sandbox is not holding' };
    if (!fs.existsSync(ran)) {
      const why = exit.stderr.trim().split('\n').pop()?.slice(0, 200) || `exit ${exit.code}`;
      return { ok: false, reason: `claude did not run a command inside the fence (${why})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `the self-test could not run: ${String(err)}` };
  } finally {
    api?.close();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── Files main writes ────────────────────────────────────────────────────────

function writeContentFile(folder: string, content: string, ext: string): string {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, contentFileName(content).replace(/\.json$/, ext));
  try {
    if (fs.readFileSync(file, 'utf8') === content) return file;
  } catch {
    /* missing: write it */
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}

/** The hook script, content-named under `<dir>/factory/worker-hooks/`. */
export function writeWorkerFenceHookScript(dir: string): string {
  return writeContentFile(path.join(dir, 'factory', 'worker-hooks'), workerFenceHookScript(), '.cjs');
}

/** The folder workers' own temp folders are made in. */
export function workerTempRoot(dir: string): string {
  return path.join(dir, 'factory', 'worker-tmp');
}

/** A worker temp folder's name: 32 hex characters. */
export const WORKER_TEMP_NAME = /^[0-9a-f]{32}$/;

/** The worker's own temp folder: the recorded one when it is still main's
 *  (a folder, not a link, directly under workerTempRoot), else a new one.
 *  `path` is what the session record keeps, `real` what the fence names. */
export function workerTempDir(dir: string, recorded?: string): { path: string; real: string } {
  const root = workerTempRoot(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (recorded && path.dirname(recorded) === root && WORKER_TEMP_NAME.test(path.basename(recorded))) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(recorded);
    } catch {
      fs.mkdirSync(recorded, { mode: 0o700 });
    }
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw fenceError('the worker\'s temp folder is not a folder of its own');
    return { path: recorded, real: fs.realpathSync(recorded) };
  }
  const made = path.join(root, crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(made, { mode: 0o700 });
  return { path: made, real: fs.realpathSync(made) };
}

// ── The worktree's git layout ────────────────────────────────────────────────

export interface WorktreeGitFacts {
  gitCommonDir: string;
  isLinkedWorktree: boolean;
  ownWorktreeName: string | null;
  ownBranch: string | null;
  otherBranches: string[];
  otherWorktrees: string[];
}

function fenceError(why: string): Error {
  return new Error(`worker fence: ${why}`);
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Every branch under `refs/heads` (loose files and packed-refs). */
function listBranches(common: string): string[] {
  const out = new Set<string>();
  const walk = (folder: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(folder, e.name), name);
      else if (e.isFile() && !e.name.endsWith('.lock')) out.add(name);
    }
  };
  walk(path.join(common, 'refs', 'heads'), '');
  for (const line of (readText(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const m = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * The worktree's git layout, from its files: its `.git` (a linked worktree's
 * pointer file or the main checkout's folder), the common dir, its branch,
 * every other branch and linked worktree. `expected`: the task ledger's
 * record of the common dir and the worktree's git dir, which must match. A
 * folder that is not a git worktree gets a common dir inside it that does
 * not exist (nothing to deny). Throws on a layout the fence cannot name.
 */
export function readWorktreeGitFacts(worktree: string, expected: { gitCommonDir?: string; gitWorktreeDir?: string } = {}): WorktreeGitFacts {
  const wt = fs.realpathSync(worktree);
  const dotGit = path.join(wt, '.git');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dotGit);
  } catch {
    if (expected.gitCommonDir) throw fenceError('the worktree has no .git, although its task was started in a repository');
    return { gitCommonDir: dotGit, isLinkedWorktree: false, ownWorktreeName: null, ownBranch: null, otherBranches: [], otherWorktrees: [] };
  }
  let gitDir: string;
  if (st.isDirectory()) {
    gitDir = fs.realpathSync(dotGit);
  } else if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
    if (!m) throw fenceError('the worktree\'s .git file does not name its git folder');
    gitDir = fs.realpathSync(path.resolve(wt, m[1]));
  } else {
    throw fenceError('the worktree\'s .git is neither a file nor a folder');
  }
  const commondir = readText(path.join(gitDir, 'commondir'));
  const common = commondir ? fs.realpathSync(path.resolve(gitDir, commondir.trim())) : gitDir;
  const same = (a: string, b: string) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };
  if (expected.gitCommonDir && !same(expected.gitCommonDir, common)) throw fenceError('the worktree\'s repository is not the one its task was started in');
  if (expected.gitWorktreeDir && !same(expected.gitWorktreeDir, gitDir)) throw fenceError('the worktree\'s git folder is not the one its task was started with');
  if (fs.existsSync(path.join(common, 'reftable'))) throw fenceError('the repository keeps its branches in a reftable, which the fence cannot close branch by branch');
  const linked = gitDir !== common;
  if (linked && path.dirname(gitDir) !== path.join(common, 'worktrees')) throw fenceError('the worktree\'s git folder is not under its repository\'s worktrees folder');
  const head = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readText(path.join(gitDir, 'HEAD')) ?? '');
  let worktrees: string[] = [];
  try {
    worktrees = fs.readdirSync(path.join(common, 'worktrees'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    worktrees = [];
  }
  return {
    gitCommonDir: common,
    isLinkedWorktree: linked,
    ownWorktreeName: linked ? path.basename(gitDir) : null,
    ownBranch: head ? head[1] : null,
    otherBranches: listBranches(common),
    otherWorktrees: worktrees,
  };
}

// ── The worktree's own Claude files ──────────────────────────────────────────

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * Why the fence cannot start in `worktree` because of its own Claude files,
 * or null: `.claude`, `.claude/settings.json`, `.claude/settings.local.json`
 * or `.mcp.json` is a link that leads out of the worktree (or nowhere): a
 * command inside the fence could have pointed it at settings of its own; or
 * the project settings turn on a sandbox of their own, turn hooks off, open
 * more folders (`permissions.additionalDirectories`) or allow a file tool,
 * each of which claude would apply on top of the fence. Checked at every
 * launch, resume and re-fire.
 */
export function workerFenceFolderRefusal(worktree: string): string | null {
  let wt: string;
  try {
    wt = fs.realpathSync(worktree);
  } catch {
    return 'the worker\'s folder could not be read';
  }
  for (const rel of ['.claude', '.mcp.json', path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json')]) {
    const p = path.join(wt, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return `${rel} is a link that leads nowhere`;
    }
    if (!isWithin(real, wt)) return `${rel} is a link out of the worktree`;
  }
  for (const name of ['settings.json', 'settings.local.json']) {
    const text = readText(path.join(wt, '.claude', name));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `.claude/${name} is not valid JSON`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `.claude/${name} is not a settings object`;
    const s = parsed as Record<string, unknown>;
    const keys = WORKER_FENCE_REFUSED_SETTINGS_KEYS.filter((k) => k in s);
    if (keys.length > 0) return `.claude/${name} sets ${keys.join(', ')}`;
    const perms = s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) ? s.permissions as Record<string, unknown> : {};
    const wide = WORKER_FENCE_REFUSED_PERMISSION_KEYS.filter((k) => k in perms);
    if (wide.length > 0) return `.claude/${name} sets permissions.${wide.join(', permissions.')}`;
    if (Array.isArray(perms.allow) && perms.allow.some((r) => typeof r !== 'string' || WORKER_FENCE_FILE_ALLOW_RULE.test(r))) {
      return `.claude/${name} allows a file tool, which widens the fence`;
    }
  }
  return null;
}

// ── The fence for one launch ─────────────────────────────────────────────────

/** How a launch is fenced, recorded with its session (a later launch of it
 *  never runs weaker than its first, botWorkerMergeGuard.ts). */
export type WorkerFenceStrength = 'full' | 'weaker' | 'off';

/** The status line a fenced worker's pane shows, or none. */
function statusLine(text: string): Record<string, unknown> {
  return { statusLine: { type: 'command', command: `echo ${shSingle(`wmux: ${text}`)}`, padding: 0 } };
}

/** A hook that refuses every call, with `reason`. */
function refuseAllHook(reason: string): Record<string, unknown> {
  return { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `echo ${shSingle(`wmux fence: ${reason}`)} >&2; exit 2` }] }] } };
}

export type WorkerFenceAttach =
  /** Not fenced: the launch is as before. */
  | { kind: 'none' }
  /** Fenced: merge `settings` into the worker's settings file. */
  | { kind: 'fence'; strength: WorkerFenceStrength; settings: Record<string, unknown>; tempDir?: string; exe?: string };

export interface WorkerFenceAttachInput {
  line: string;
  /** The worker's folder (absolute); none for a WSL pane. */
  cwd?: string;
  wsl: boolean;
  /** The data folder. */
  dir: string;
  /** The owner turned the fence off for the bot's workspace. */
  switchedOff: boolean;
  /** What the session's first launch recorded (a resume, a re-fire). */
  recorded?: { strength: WorkerFenceStrength; tempDir?: string };
  support: WorkerFenceSupport | null;
  /** The task ledger's git dirs for the worktree. */
  expectedGit?: { gitCommonDir?: string; gitWorktreeDir?: string };
  /** The hook's runtime (default: this process's). */
  runtime?: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  accountConfigDirs?: readonly string[];
  platform?: NodeJS.Platform;
}

/**
 * The fence for one claude launch of a bot's worker. `none` for a line that
 * does not run unattended (manual, acceptEdits, plan, default). Throws (the
 * launch is refused) when the fence should be on but cannot be built: the
 * worktree's files or git layout refuse it, or the platform ran the full
 * fence for this session before and cannot now.
 */
export function attachWorkerFence(input: WorkerFenceAttachInput): WorkerFenceAttach {
  if (!isFencedMode(linePermissionMode(input.line))) return { kind: 'none' };
  const wanted = !input.switchedOff || (input.recorded !== undefined && input.recorded.strength !== 'off');
  if (!wanted) return { kind: 'fence', strength: 'off', settings: statusLine('the worker fence is off for this workspace') };
  const home = input.home ?? os.homedir();
  const credentials = workerFenceCredentialPaths({ botDir: input.cwd ?? input.dir, wmuxDir: input.dir, env: input.env ?? process.env, home, ...(input.accountConfigDirs ? { accountConfigDirs: input.accountConfigDirs } : {}), ...(input.platform ? { platform: input.platform } : {}) });
  if (input.wsl) {
    // The distro's claude: the permission denies (rules by `~/`, its own
    // home) and the marker. The hook's runtime does not run there.
    if (input.recorded?.strength === 'full') throw fenceError('this worker started inside the full fence, which a WSL pane cannot run');
    const deny = workerFencePermissionDenies(credentials, [], home);
    return { kind: 'fence', strength: 'weaker', settings: { permissions: { deny }, ...statusLine('weaker worker fence: a WSL pane has no file hook and no OS sandbox') } };
  }
  if (!input.cwd) throw fenceError('the worker has no folder to fence');
  const support = input.support;
  if (!support) throw fenceError('this computer\'s fence support was not checked yet; try again');
  if (!support.capable && input.recorded?.strength === 'full') throw fenceError(`this worker started inside the full fence, which cannot run now (${support.reason})`);
  const refusal = workerFenceFolderRefusal(input.cwd);
  if (refusal) throw fenceError(refusal);
  const worktree = fs.realpathSync(input.cwd);
  const temp = workerTempDir(input.dir, input.recorded?.tempDir);
  const tempDir = temp.path;
  const git = readWorktreeGitFacts(worktree, input.expectedGit);
  const script = writeWorkerFenceHookScript(input.dir);
  const hookCommand = workerFenceHookCommand(input.runtime ?? process.execPath, script, [worktree, temp.real], input.platform);
  if (!hookCommand) throw fenceError('the fence hook\'s command cannot be written for these paths');
  const fence = buildWorkerFence({
    worktree, workerTempDir: temp.real, ...git, platformCapable: support.capable, repoTestWritePaths: [],
    permissionMode: linePermissionMode(input.line) ?? 'bypassPermissions', hookCommand, credentialPaths: credentials, home,
  });
  if (!support.capable) {
    return { kind: 'fence', strength: 'weaker', tempDir, settings: { ...fence.settings, ...statusLine(`weaker worker fence: no OS sandbox here (${support.reason})`) } };
  }
  if (!support.selfTest.ok) {
    // The sandbox did not hold in the self-test: no tool runs.
    const why = `the fence failed its self-test, so this worker has no tools (${support.selfTest.reason})`;
    const merged = { ...fence.settings, ...statusLine(why) };
    const hooks = (merged.hooks as { PreToolUse: unknown[] }).PreToolUse;
    (merged.hooks as { PreToolUse: unknown[] }).PreToolUse = [...(refuseAllHook(why).hooks as { PreToolUse: unknown[] }).PreToolUse, ...hooks];
    return { kind: 'fence', strength: 'full', tempDir, settings: merged, exe: support.exe };
  }
  return { kind: 'fence', strength: 'full', tempDir, settings: fence.settings, exe: support.exe };
}

/** Startup: remove worker temp folders no session record names and that
 *  were not touched for a day. Best effort. */
export function pruneWorkerTempDirs(dir: string, named: ReadonlySet<string>, now: number = Date.now()): number {
  const root = workerTempRoot(dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const p = path.join(root, name);
    if (named.has(p) || !WORKER_TEMP_NAME.test(name)) continue;
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || now - st.mtimeMs < 24 * 3600_000) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  return removed;
}
