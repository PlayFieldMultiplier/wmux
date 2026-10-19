// ─── How Claude is actually spawned (probe + BotRuntime / SDK) ─────────────
//
// ClaudeSdkAdapter hands the resolved path to the Anthropic agent SDK as
// `pathToClaudeCodeExecutable`. The SDK then:
//   • runs script paths (`.js` / `.mjs` / `.ts` / `.tsx` / `.jsx`) under
//     `node` (or bun) — see YK() in @anthropic-ai/claude-agent-sdk;
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
// never disagrees with how BotRuntime's SDK session launches Claude.

import * as path from 'path';

/** Same extensions the Anthropic Claude Agent SDK treats as scripts (YK). */
const SCRIPT_EXTS = ['.js', '.mjs', '.tsx', '.ts', '.jsx'] as const;

export interface ClaudeLaunch {
  command: string;
  args: string[];
  /** When true, pass `windowsVerbatimArguments` to spawn / execFile. */
  windowsVerbatimArguments?: boolean;
}

export interface ResolveClaudeLaunchOpts {
  /** Extra CLI args after the executable (e.g. `['--version']`). */
  args?: readonly string[];
  /** Node (or bun) binary for script paths. Default: `process.execPath`. */
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  /** Absolute path to cmd.exe on Windows. Default: SystemRoot\System32\cmd.exe. */
  cmdExecutable?: string;
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
 * Turn a resolved Claude path into the `{ command, args }` BotRuntime's SDK
 * session (and this probe) actually spawn. Pure aside from defaulting
 * `nodeExecutable` / `cmdExecutable` / `platform` to the process.
 */
export function resolveClaudeLaunch(exe: string, opts: ResolveClaudeLaunchOpts = {}): ClaudeLaunch {
  const platform = opts.platform ?? process.platform;
  const extra = opts.args ? [...opts.args] : [];
  if (!exe) return { command: exe, args: extra };

  if (isScriptPath(exe)) {
    return {
      command: opts.nodeExecutable ?? process.execPath,
      args: [exe, ...extra],
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
