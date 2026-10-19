// ─── How Claude is actually spawned (probe + BotRuntime / SDK) ─────────────
//
// ClaudeSdkAdapter hands the resolved path to the Anthropic agent SDK as
// `pathToClaudeCodeExecutable`. The SDK then (sdk.mjs YK + yS.initialize):
//   • runs script paths (`.js` / `.mjs` / `.ts` / `.tsx` / `.jsx`) under
//     PATH `node` (or `bun` when `process.versions.bun` is set) —
//     getDefaultExecutable() returns the literal string "node" / "bun",
//     never process.execPath;
//   • otherwise spawns the path directly.
//
// Windows npm also ships a `claude.cmd` shim. Node 20+ refuses to execFile a
// `.cmd`/`.bat` (EINVAL); those go through cmd.exe the same way
// shell.handler launches folder apps. resolveClaudeExecutable skips .cmd on
// PATH, but an install/override can still hand one back — the probe must not
// flag a valid install as claude-unusable.
//
// This module is the ONE place that turns a resolved Claude path into
// `{ command, args }` for a direct spawn. The readiness probe uses it so it
// never disagrees with how BotRuntime's SDK session launches Claude. Do NOT
// default scripts to process.execPath: in Electron main that is the wmux
// binary, and without ELECTRON_RUN_AS_NODE a valid npm cli.js install is
// falsely flagged claude-unusable.

import * as path from 'path';

/** Same extensions the Anthropic Claude Agent SDK treats as scripts (YK). */
const SCRIPT_EXTS = ['.js', '.mjs', '.tsx', '.ts', '.jsx'] as const;

export interface ClaudeLaunch {
  command: string;
  args: string[];
  /** When true, pass `windowsVerbatimArguments` to spawn / execFile. */
  windowsVerbatimArguments?: boolean;
  /** Merged into the child env (e.g. ELECTRON_RUN_AS_NODE for an Electron host). */
  env?: Record<string, string>;
}

export interface ResolveClaudeLaunchOpts {
  /** Extra CLI args after the executable (e.g. `['--version']`). */
  args?: readonly string[];
  /**
   * Host for script paths. Default: PATH `node` (or `bun` under bun) — the
   * same literal the Claude Agent SDK's getDefaultExecutable() returns.
   * Pass an absolute Electron binary only as an explicit fallback; we then
   * set ELECTRON_RUN_AS_NODE=1 so it behaves as Node.
   */
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  /** Absolute path to cmd.exe on Windows. Default: SystemRoot\System32\cmd.exe. */
  cmdExecutable?: string;
  /**
   * Test / documentation seam: the process execPath that used to be the
   * mistaken default. Ignored for the script host (SDK uses PATH node). Kept
   * so a regression that prefers execPath over PATH can be asserted against.
   */
  execPath?: string;
}

function isScriptPath(exe: string): boolean {
  const lower = exe.toLowerCase();
  return SCRIPT_EXTS.some((ext) => lower.endsWith(ext));
}

function isBatchPath(exe: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const lower = exe.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function defaultCmdExecutable(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'cmd.exe');
}

/**
 * Same as @anthropic-ai/claude-agent-sdk getDefaultExecutable(): the PATH
 * name `node`, or `bun` when this process is bun. Never process.execPath.
 */
export function sdkDefaultScriptHost(): string {
  return typeof process.versions.bun === 'string' ? 'bun' : 'node';
}

/** True when `command` is an Electron (or other non-Node) binary that needs
 *  ELECTRON_RUN_AS_NODE to run a .js entrypoint. */
function needsElectronRunAsNode(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base !== 'node' && base !== 'node.exe' && base !== 'bun' && base !== 'bun.exe';
}

/**
 * Turn a resolved Claude path into the `{ command, args }` BotRuntime's SDK
 * session (and this probe) actually spawn. Pure aside from defaulting
 * `nodeExecutable` / `cmdExecutable` / `platform` to the process.
 */
export function resolveClaudeLaunch(exe: string, opts: ResolveClaudeLaunchOpts = {}): ClaudeLaunch {
  const platform = opts.platform ?? process.platform;
  const extra = opts.args ? [...opts.args] : [];
  if (!exe) return { command: exe, args: extra };

  if (isScriptPath(exe)) {
    // Prefer an explicit host; otherwise PATH node/bun like the SDK.
    // opts.execPath is intentionally NOT consulted — that was the Electron
    // main bug (wmux binary without ELECTRON_RUN_AS_NODE).
    void opts.execPath;
    const command = opts.nodeExecutable ?? sdkDefaultScriptHost();
    const env = needsElectronRunAsNode(command) ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
    return {
      command,
      args: [exe, ...extra],
      ...(env ? { env } : {}),
    };
  }

  if (isBatchPath(exe, platform)) {
    // cmd.exe /d /s /c ""path" "arg1" …" — same quoting as shell.handler's
    // launchFolderApp. Refuse embedded quotes rather than escaping them.
    const tokens = [exe, ...extra];
    if (tokens.some((t) => /["\r\n]/.test(t))) {
      // Unquotable: fall back to a direct spawn that will fail with EINVAL
      // rather than inventing a shell line. Callers surface the failure.
      return { command: exe, args: extra };
    }
    const inner = tokens.map((t) => `"${t}"`).join(' ');
    return {
      command: opts.cmdExecutable ?? defaultCmdExecutable(),
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { command: exe, args: extra };
}
