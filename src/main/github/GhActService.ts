// ─── gh for the acts the owner approved (factory/actExecutor.ts) ───────────
//
// Every call is `gh api --hostname <host> <endpoint>` run with an argv (no
// shell), gh's whitelisted env (ghIssueEnv: no GH_REPO) and the shared
// per-host rate-limit breaker. A write sends `-X <method> --input -` with a
// JSON body main built, on stdin: no field value reaches gh's argv, so gh's
// `-F` value expansion (`@file`, `{owner}`) and Windows argument quoting never
// touch the text the owner approved. The working folder is one main owns,
// never a bot's checkout (a worker can write there).
//
// An answer is classified for the executor: ok (the parsed JSON, or null for
// an empty answer such as a DELETE's 204), http (GitHub answered 4xx: nothing
// was written), rate-limited or unsent (nothing reached GitHub), or error
// (anything else: it may have been written).

import { execFile } from 'node:child_process';
import { ghIssueEnv } from './GhIssueService';
import { GhRateBreaker, ghRateBreaker, isRateLimitError } from './ghRateBreaker';

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export type GhActAnswer =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'http'; status: number; message: string }
  /** rate-limited / unsent: nothing reached GitHub (the breaker, a gh that
   *  could not be started). */
  | { ok: false; kind: 'rate-limited' | 'unsent' | 'error'; message: string };

export type GhActMethod = 'POST' | 'PATCH' | 'DELETE';

export interface GhActPort {
  read(host: string, endpoint: string): Promise<GhActAnswer>;
  write(host: string, method: GhActMethod, endpoint: string, body: Record<string, unknown>): Promise<GhActAnswer>;
}

/** The program gh runs as: `gh` (tests: node and a script). */
export interface GhCommand {
  file: string;
  prefix: readonly string[];
}

const DEFAULT_GH: GhCommand = { file: process.platform === 'win32' ? 'gh.exe' : 'gh', prefix: [] };

/** An endpoint main built: `repos/…`, `user`, a query of plain characters. */
const ENDPOINT_RE = /^[A-Za-z0-9._~/?&=%:-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d+)?$/;

function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown })?.stderr;
  return typeof s === 'string' ? s : '';
}

/** The HTTP status gh reported (`gh: … (HTTP 422)`), or null. */
export function httpStatusOf(stderr: string): number | null {
  const m = /\(HTTP (\d{3})\)/.exec(stderr);
  return m ? Number(m[1]) : null;
}

export class GhActService implements GhActPort {
  constructor(
    private readonly cwd: () => string,
    private readonly command: GhCommand = DEFAULT_GH,
    private readonly breaker: GhRateBreaker = ghRateBreaker,
  ) {}

  read(host: string, endpoint: string): Promise<GhActAnswer> {
    return this.run(host, endpoint, [], undefined, READ_TIMEOUT_MS);
  }

  write(host: string, method: GhActMethod, endpoint: string, body: Record<string, unknown>): Promise<GhActAnswer> {
    return this.run(host, endpoint, ['-X', method], JSON.stringify(body), WRITE_TIMEOUT_MS);
  }

  private run(host: string, endpoint: string, method: string[], input: string | undefined, timeout: number): Promise<GhActAnswer> {
    if (!HOST_RE.test(host) || !ENDPOINT_RE.test(endpoint)) return Promise.resolve({ ok: false, kind: 'unsent', message: 'not a GitHub endpoint main builds' });
    const args = ['api', '--hostname', host, ...method, endpoint, ...(input !== undefined ? ['--input', '-'] : [])];
    if (this.breaker.retryAt(host) !== null) return Promise.resolve({ ok: false, kind: 'rate-limited', message: 'GitHub rate limit' });
    return new Promise<GhActAnswer>((resolve) => {
      const child = execFile(this.command.file, [...this.command.prefix, ...args], {
        cwd: this.cwd(), timeout, env: ghIssueEnv(), windowsHide: true, maxBuffer: MAX_BUFFER,
      }, (err, stdout, stderr) => {
        if (err) {
          // gh could not be started: nothing was sent.
          if (typeof (err as { code?: unknown }).code === 'string' && /^(ENOENT|EACCES|EPERM)$/.test((err as { code: string }).code)) {
            resolve({ ok: false, kind: 'unsent', message: `gh could not be started (${(err as { code: string }).code})` });
            return;
          }
          const e = Object.assign(err, { stderr: typeof stderr === 'string' ? stderr : '' });
          if (isRateLimitError(e)) {
            this.breaker.trip(host);
            resolve({ ok: false, kind: 'rate-limited', message: 'GitHub rate limit' });
            return;
          }
          const text = stderrOf(e).trim() || String(err);
          const status = httpStatusOf(stderrOf(e));
          resolve(status !== null && status >= 400 && status < 500
            ? { ok: false, kind: 'http', status, message: text.slice(0, 300) }
            : { ok: false, kind: 'error', message: text.slice(0, 300) });
          return;
        }
        this.breaker.reset(host);
        try {
          const text = String(stdout).trim();
          resolve({ ok: true, value: text ? JSON.parse(text) as unknown : null });
        } catch {
          resolve({ ok: false, kind: 'error', message: 'gh answered something that is not JSON' });
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
  }
}
