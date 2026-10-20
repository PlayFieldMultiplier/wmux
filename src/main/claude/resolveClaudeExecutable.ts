import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// One answer to "where is the user's claude?", shared by Moa (the deck
// adapters) and the first-run wizard's "Claude Code detected" row so the two
// can never disagree.
//
// Order: PATH first (what the user's own terminal would run), then the
// install locations a GUI-launched app often misses on PATH (macOS apps
// started from Finder get a minimal PATH, so Homebrew and ~/.local/bin are
// checked explicitly).
//
// Windows: a `claude.cmd` npm shim is NOT spawnable (Node 20+ EINVAL without
// shell:true), so .cmd/.bat hits from PATHEXT are skipped and the npm
// package's real entrypoint (bin/claude.exe, or cli.js run via node) is used.

export interface ResolveClaudeEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  /** True when `p` is an existing regular file (or symlink to one) that this
   *  process may run (POSIX: X_OK). A non-executable `claude` is skipped. */
  isFile: (p: string) => boolean;
  /** Entry names in a folder; [] when unreadable. Used for version managers. */
  readDir?: (p: string) => string[];
  /** File contents, or null. Used for nvm's `alias/default`. */
  readText?: (p: string) => string | null;
  /** PATH as the user's login shell sets it (GUI launches miss it), or null. */
  loginShellPath?: () => string | null;
}

/** Newest-first by numeric version (v22.3.0 > v20.11.1 > v9.0.0). */
function byVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** nvm installs: the `default` alias first, then newest. */
function nvmBins(r: ResolveClaudeEnv, p: typeof path.posix, name: AgentBinary): string[] {
  const nvmDir = r.env.NVM_DIR || p.join(r.homedir, '.nvm');
  const root = p.join(nvmDir, 'versions', 'node');
  const versions = (r.readDir?.(root) ?? []).filter((v) => /^v?\d/.test(v)).sort(byVersionDesc);
  if (versions.length === 0) return [];
  const alias = r.readText?.(p.join(nvmDir, 'alias', 'default'))?.trim().replace(/^v/, '');
  const preferred = alias ? versions.find((v) => v.replace(/^v/, '') === alias || v.replace(/^v/, '').startsWith(`${alias}.`)) : undefined;
  const ordered = preferred ? [preferred, ...versions.filter((v) => v !== preferred)] : versions;
  return ordered.map((v) => p.join(root, v, 'bin', name));
}

/** fnm installs, newest first. */
function fnmBins(r: ResolveClaudeEnv, p: typeof path.posix, name: AgentBinary): string[] {
  const dirs = r.env.FNM_DIR
    ? [r.env.FNM_DIR]
    : r.platform === 'darwin'
      ? [p.join(r.homedir, 'Library', 'Application Support', 'fnm'), p.join(r.homedir, '.local', 'share', 'fnm')]
      : [p.join(r.env.XDG_DATA_HOME || p.join(r.homedir, '.local', 'share'), 'fnm'), p.join(r.homedir, '.fnm')];
  const out: string[] = [];
  for (const d of dirs) {
    const root = p.join(d, 'node-versions');
    for (const v of (r.readDir?.(root) ?? []).filter((x) => /^v?\d/.test(x)).sort(byVersionDesc)) {
      out.push(p.join(root, v, 'installation', 'bin', name));
    }
  }
  return out;
}

const UNSPAWNABLE_EXTS = new Set(['.cmd', '.bat']);

function pathDirs(r: ResolveClaudeEnv, raw: string = r.env.PATH ?? r.env.Path ?? r.env.path ?? ''): string[] {
  const sep = r.platform === 'win32' ? ';' : ':';
  const p = r.platform === 'win32' ? path.win32 : path.posix;
  // Only absolute entries: an empty entry or '.' means "the current folder",
  // which would let a `claude` planted in an opened repo run instead of the
  // user's install (Windows also searches cwd first; we never do).
  return raw
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && p.isAbsolute(d) && !(r.platform === 'win32' && /^[\\/](?![\\/])/.test(d)));
}

function pathExts(r: ResolveClaudeEnv): string[] {
  const raw = r.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.') && !UNSPAWNABLE_EXTS.has(e));
}

/** The agent CLIs this resolver knows the install locations of. */
export type AgentBinary = 'claude' | 'codex';

/** Every candidate path, in priority order. Pure; exported for tests. */
export function claudeCandidates(r: ResolveClaudeEnv): string[] {
  return agentCandidates(r, 'claude');
}

/**
 * Candidate paths for one agent CLI, in priority order: PATH first, then the
 * agent's own installer location, then npm / Homebrew / Node version managers.
 * Codex's fixed locations come from its standalone installers
 * (https://chatgpt.com/codex/install.sh: `$HOME/.local/bin/codex`;
 * https://chatgpt.com/codex/install.ps1:
 * `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`) and its npm
 * package (`@openai/codex`, entrypoint `bin/codex.js`).
 */
export function agentCandidates(r: ResolveClaudeEnv, name: AgentBinary): string[] {
  const p = r.platform === 'win32' ? path.win32 : path.posix;
  const out: string[] = [];
  const win = r.platform === 'win32';
  for (const dir of pathDirs(r)) {
    if (win) for (const ext of pathExts(r)) out.push(p.join(dir, `${name}${ext}`));
    else out.push(p.join(dir, name));
  }
  // Native installer (self-updating). Codex's Windows installer uses its own
  // folder (below), so ~/.local/bin is only its POSIX location.
  if (name === 'claude') out.push(p.join(r.homedir, '.local', 'bin', win ? 'claude.exe' : 'claude'));
  else if (!win) out.push(p.join(r.homedir, '.local', 'bin', name));
  if (win) {
    const appData = r.env.APPDATA;
    if (name === 'claude') {
      if (appData) {
        const pkg = p.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
        out.push(p.join(pkg, 'bin', 'claude.exe'), p.join(pkg, 'cli.js'));
      }
    } else {
      const localAppData = r.env.LOCALAPPDATA;
      if (localAppData) out.push(p.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
      if (appData) out.push(p.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  } else {
    // npm global prefix: explicit config, then the common user-level prefix.
    const prefix = r.env.npm_config_prefix ?? r.env.NPM_CONFIG_PREFIX;
    if (prefix) out.push(p.join(prefix, 'bin', name));
    out.push(p.join(r.homedir, '.npm-global', 'bin', name));
    // Homebrew (Apple silicon, Intel / Linuxbrew-style).
    out.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
    out.push(`/home/linuxbrew/.linuxbrew/bin/${name}`);
    // Node version managers (npm -g lands inside the active Node's bin).
    out.push(p.join(r.env.VOLTA_HOME || p.join(r.homedir, '.volta'), 'bin', name));
    out.push(...nvmBins(r, p as typeof path.posix, name), ...fnmBins(r, p as typeof path.posix, name));
  }
  return [...new Set(out)];
}

function firstHit(r: ResolveClaudeEnv, candidates: string[]): string | null {
  const p = r.platform === 'win32' ? path.win32 : path.posix;
  for (const c of candidates) {
    if (!p.isAbsolute(c)) continue;
    try {
      if (r.isFile(c)) return c;
    } catch {
      /* inaccessible path — keep scanning */
    }
  }
  return null;
}

export function resolveClaudeExecutableWith(r: ResolveClaudeEnv): string | null {
  return resolveAgentExecutableWith(r, 'claude');
}

export function resolveAgentExecutableWith(r: ResolveClaudeEnv, name: AgentBinary): string | null {
  const hit = firstHit(r, agentCandidates(r, name));
  if (hit || r.platform === 'win32' || !r.loginShellPath) return hit;
  // Last resort, and only then (it spawns a shell once): the PATH the user's
  // login shell builds. A Finder/Dock launch inherits a minimal PATH without
  // the nvm/fnm/volta lines from ~/.zshrc. Same absolute-only rule as PATH.
  const login = r.loginShellPath();
  if (!login) return null;
  return firstHit(r, pathDirs(r, login).map((d) => path.posix.join(d, name)));
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const LOGIN_SHELL_TIMEOUT_MS = 2500;
const PATH_START = '__WMUX_PATH_START__';
const PATH_END = '__WMUX_PATH_END__';

/** The PATH between our markers; rc files may print banners around it. */
export function parseMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(PATH_START);
  if (start < 0) return null;
  const from = start + PATH_START.length;
  const end = output.indexOf(PATH_END, from);
  if (end < 0) return null;
  const value = output.slice(from, end).trim();
  return value || null;
}

export interface LoginShellPathOptions {
  shell?: string;
  home?: string;
  timeoutMs?: number;
}

/** Ask the user's login shell for its PATH. Async and never throws: runs with
 *  cwd = home (never an opened repo, whose rc hooks could act on it), stdin
 *  ignored, killed after `timeoutMs`; any failure resolves null so callers
 *  fall back to the fixed candidates. */
export function loadLoginShellPath(opts: LoginShellPathOptions = {}): Promise<string | null> {
  const shell = opts.shell ?? process.env.SHELL;
  const home = opts.home ?? os.homedir();
  if (process.platform === 'win32' || !shell || !path.isAbsolute(shell)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const child = execFile(
        shell,
        ['-ilc', `printf '${PATH_START}%s${PATH_END}' "$PATH"`],
        { cwd: home, encoding: 'utf8', timeout: opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) { resolve(null); return; }
          resolve(parseMarkedPath(String(stdout)));
        },
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

let loginPathCache: string | null = null;
let loginPathWarm: Promise<string | null> | null = null;

/** Start (once) reading the login-shell PATH in the background. Called at app
 *  start; Moa never waits on it — until it lands, resolution uses PATH and
 *  the fixed locations only. */
export function warmLoginShellPath(): Promise<string | null> {
  if (!loginPathWarm) {
    loginPathWarm = loadLoginShellPath().then((value) => {
      loginPathCache = value;
      if (value) console.log('[claude] login shell PATH loaded');
      return value;
    });
  }
  return loginPathWarm;
}

function cachedLoginShellPath(): string | null {
  if (!loginPathWarm) void warmLoginShellPath();
  return loginPathCache;
}

let lastLogged: string | null | undefined;

/** The live inputs both resolvers read. `env` is a parameter so a caller can
 *  pass a PATH re-read from the Windows registry after an install. */
export function liveResolveEnv(env: Record<string, string | undefined> = process.env): ResolveClaudeEnv {
  return {
    platform: process.platform,
    env,
    homedir: os.homedir(),
    isFile: isExecutableFile,
    readDir,
    readText,
    loginShellPath: cachedLoginShellPath,
  };
}

/** Where the user's Codex CLI is, by the same rules as {@link resolveClaudeExecutable}. */
export function resolveCodexExecutable(env?: Record<string, string | undefined>): string | null {
  return resolveAgentExecutableWith(liveResolveEnv(env), 'codex');
}

export function resolveClaudeExecutable(): string | null {
  const found = resolveClaudeExecutableWith({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    isFile: isExecutableFile,
    readDir,
    readText,
    loginShellPath: cachedLoginShellPath,
  });
  if (found !== lastLogged) {
    lastLogged = found;
    console.log(`[claude] executable: ${found ?? 'not found'}`);
  }
  return found;
}
