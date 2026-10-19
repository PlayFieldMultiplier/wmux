// ─── A cheap, non-billing check that Claude Code actually runs ─────────────
//
// engineReadiness already knows the executable path and that a sign-in is
// stored. A path that exists is not enough: a broken install, a shim that
// cannot spawn, or a binary that exits on contact still blocks the first bot
// turn with a raw English engine_unavailable. This probe runs `claude
// --version` once, with a short timeout and stdin closed, and never asks the
// model for anything (no quota, no billing).

import { execFile } from 'node:child_process';

export const CLAUDE_PROBE_TIMEOUT_MS = 2_500;

export type ClaudeProbeResult =
  | { ok: true; version: string }
  | { ok: false; detail: string };

export interface ClaudeProbeDeps {
  /** Test seam: run `exe` with `args`. Default: execFile with closed stdin. */
  run?: (exe: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  timeoutMs?: number;
}

function defaultRun(exe: string, args: readonly string[], opts: { timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        exe,
        [...args],
        {
          encoding: 'utf8',
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          windowsHide: true,
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

/**
 * Run `exe --version`. Never throws. A non-zero exit, a timeout, or an empty
 * answer is `{ ok: false }` with a short, credential-free detail.
 */
export async function probeClaudeExecutable(exe: string, deps: ClaudeProbeDeps = {}): Promise<ClaudeProbeResult> {
  if (!exe || typeof exe !== 'string') return { ok: false, detail: 'no claude executable path' };
  const timeoutMs = deps.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS;
  const run = deps.run ?? defaultRun;
  let r: { code: number | null; stdout: string; stderr: string };
  try {
    r = await run(exe, ['--version'], { timeoutMs });
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
  }
  if (r.code === null) return { ok: false, detail: `claude --version timed out after ${timeoutMs}ms` };
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code !== 0) {
    const detail = (out || `claude --version exited ${r.code}`).replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, detail };
  }
  const version = (r.stdout || r.stderr).trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!version) return { ok: false, detail: 'claude --version printed nothing' };
  return { ok: true, version: version.slice(0, 120) };
}
