// ─── A cheap, non-billing check that Claude Code actually runs ─────────────
//
// engineReadiness already knows the executable path and that a sign-in is
// stored. A path that exists is not enough: a broken install, a shim that
// cannot spawn, or a binary that exits on contact still blocks the first bot
// turn with a raw English engine_unavailable. This probe runs `claude
// --version` once, with a short timeout and stdin closed, and never asks the
// model for anything (no quota, no billing).
//
// Launch matches BotRuntime / the Claude Agent SDK (resolveClaudeLaunch): a
// Windows `.cmd` goes through cmd.exe, a `cli.js` under PATH `node` (SDK), never Electron execPath. Successful
// answers are cached by resolved path + mtime so opening the Bots page does
// not re-probe every readiness poll. Failure detail is redacted before it
// reaches lastError / the UI.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { resolveClaudeLaunch, type ClaudeLaunch, type ResolveClaudeLaunchOpts } from '../claude/resolveClaudeLaunch';
import { redactSecrets } from '../../shared/redactSecrets';

export const CLAUDE_PROBE_TIMEOUT_MS = 2_500;

export type ClaudeProbeResult =
  | { ok: true; version: string }
  | { ok: false; detail: string };

export interface ClaudeProbeDeps {
  /** Test seam: run `command` with `args`. Default: execFile with closed stdin. */
  run?: (
    command: string,
    args: readonly string[],
    opts: { timeoutMs: number; windowsVerbatimArguments?: boolean; env?: Record<string, string> },
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  timeoutMs?: number;
  /** Override launch resolution (tests). */
  resolveLaunch?: (exe: string, args: readonly string[]) => ClaudeLaunch;
  /** mtimeMs of `exe`, or null when unreadable. Default: fs.statSync. */
  mtimeMs?: (exe: string) => number | null;
  /** When false, skip the success cache (tests). Default: true. */
  useCache?: boolean;
  /** Forwarded to resolveClaudeLaunch when `resolveLaunch` is absent. */
  launchOpts?: Omit<ResolveClaudeLaunchOpts, 'args'>;
}

/** The probe's environment: main's, with the launch's overlay, and without
 *  NODE_OPTIONS, which the Agent SDK deletes before it spawns Claude (a
 *  preload hook in it must not fail a probe the bots' launch would pass). */
export function probeEnv(overlay: Record<string, string> | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(overlay ?? {}) };
  delete env.NODE_OPTIONS;
  return env;
}

function defaultRun(
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number; windowsVerbatimArguments?: boolean; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          windowsHide: true,
          ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          env: probeEnv(opts.env),
        },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : '';
          const errText = typeof stderr === 'string' ? stderr : '';
          if (!err) {
            resolve({ code: 0, stdout: out, stderr: errText });
            return;
          }
          const e = err as NodeJS.ErrnoException & { status?: number | null; killed?: boolean; signal?: string | null };
          // A timeout sets killed / signal; treat as no exit code.
          if (e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT') {
            resolve({ code: null, stdout: out, stderr: errText || e.message });
            return;
          }
          const status = typeof e.status === 'number' ? e.status : 1;
          resolve({ code: status, stdout: out, stderr: errText || e.message });
        },
      );
      // Closed stdin: the CLI must not wait on a TTY or an open pipe.
      child.stdin?.end();
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
    }
  });
}

function defaultMtimeMs(exe: string): number | null {
  try {
    return fs.statSync(exe).mtimeMs;
  } catch {
    return null;
  }
}

function failDetail(raw: string): string {
  return redactSecrets(raw.replace(/\s+/g, ' ').trim()).slice(0, 200);
}

/** Success-only cache: path + mtimeMs → version. Failures always re-probe. */
const successCache = new Map<string, { mtimeMs: number; version: string }>();

function cacheKey(exe: string, mtimeMs: number): string {
  return `${exe}\0${mtimeMs}`;
}

/** Test seam: drop the success cache. */
export function clearClaudeProbeCache(): void {
  successCache.clear();
}

/**
 * Run `exe --version` the way BotRuntime's SDK session would launch `exe`.
 * Never throws. A non-zero exit, a timeout, or an empty answer is
 * `{ ok: false }` with a short, redacted, credential-free detail.
 */
export async function probeClaudeExecutable(exe: string, deps: ClaudeProbeDeps = {}): Promise<ClaudeProbeResult> {
  if (!exe || typeof exe !== 'string') return { ok: false, detail: 'no claude executable path' };

  const mtimeMs = (deps.mtimeMs ?? defaultMtimeMs)(exe);
  const useCache = deps.useCache !== false;
  if (useCache && mtimeMs !== null) {
    const hit = successCache.get(cacheKey(exe, mtimeMs));
    if (hit && hit.mtimeMs === mtimeMs) return { ok: true, version: hit.version };
  }

  const timeoutMs = deps.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS;
  const launch =
    deps.resolveLaunch?.(exe, ['--version']) ??
    resolveClaudeLaunch(exe, { ...deps.launchOpts, args: ['--version'] });
  const run = deps.run ?? defaultRun;

  let r: { code: number | null; stdout: string; stderr: string };
  try {
    r = await run(launch.command, launch.args, {
      timeoutMs,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(launch.env ? { env: launch.env } : {}),
    });
  } catch (err) {
    return { ok: false, detail: failDetail(err instanceof Error ? err.message : String(err)) };
  }
  if (r.code === null) return { ok: false, detail: failDetail(`claude --version timed out after ${timeoutMs}ms`) };
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0) {
    return { ok: false, detail: failDetail(out || `claude --version exited ${r.code}`) };
  }
  const version = (r.stdout || r.stderr).trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!version) return { ok: false, detail: failDetail('claude --version printed nothing') };
  const okVersion = version.slice(0, 120);
  if (useCache && mtimeMs !== null) {
    successCache.set(cacheKey(exe, mtimeMs), { mtimeMs, version: okVersion });
  }
  return { ok: true, version: okVersion };
}
