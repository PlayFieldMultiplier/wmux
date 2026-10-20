import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_IDS,
  AGENT_UPDATE_FLOORS,
  isOlderVersion,
  parseAgentVersion,
  type AgentId,
  type AgentSetupStatus,
} from '../../shared/agentSetup';
import { isInternalEnvKey } from '../../shared/envFilter';
import {
  agentCandidates,
  liveResolveEnv,
  resolveAgentExecutableWith,
} from '../claude/resolveClaudeExecutable';
import { resolveClaudeLaunch } from '../claude/resolveClaudeLaunch';

// Read-only detector behind the wizard's "Agent ready" cards: is each agent
// installed, which version, and is it signed in.
//
// Sign-in is read from each agent's own documented status subcommand, never
// from its credential store, so wmux reads no token and needs no knowledge of
// where an agent keeps one (Keychain, a file, a keyring):
//   - Claude Code: `claude auth status --json` (`claude auth status --help`:
//     "--json  Output as JSON (default)"). Measured on 2.1.305: exit 0 with
//     `"loggedIn": true`, exit 1 with `"loggedIn": false`. The JSON also holds
//     the account e-mail and organisation; only the boolean leaves this file.
//   - Codex: `codex login status` (`codex login --help`: "status  Show login
//     status"). Measured on codex-cli 0.163.0: exit 0 when signed in, exit 1
//     printing "Not logged in" when not.
// Anything else (a timeout, an old version without the subcommand, a crash) is
// "could not tell", never "signed out". Probe output is never logged.

/** Output of one probe. `code` is null when the process did not exit normally. */
export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; windowsVerbatimArguments?: boolean },
) => Promise<ProbeResult>;

export interface AgentSetupDetectorDeps {
  /** Executable for an agent, or null. Defaults to the shared resolver over `env()`. */
  resolve?: (agent: AgentId, env: NodeJS.ProcessEnv) => string | null;
  /** Candidate list shown when nothing was found. */
  candidates?: (agent: AgentId, env: NodeJS.ProcessEnv) => string[];
  run?: ProbeRunner;
  /** The environment probes start from (scrubbed before use). */
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_OUTPUT = 64 * 1024;
/** The candidate list is for a person to read, not a full scan dump. */
const MAX_CANDIDATES = 12;

const STATUS_ARGS: Readonly<Record<AgentId, readonly string[]>> = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
};

/**
 * The environment a probe runs with. A wmux started from inside a pane (or an
 * agent session) inherits that session's markers; a probe that saw them could
 * report on, or attach to, that session instead of the user's own install. So:
 *   - wmux/Electron internals and agent-nesting markers go (the same predicate
 *     every pane spawn uses), plus every WMUX_* pane identity variable;
 *   - CODEX_* session variables go, but CODEX_HOME stays, like CLAUDE_CONFIG_DIR:
 *     both name the user's real config dir, which is what must be checked;
 *   - DISABLE_AUTOUPDATER=1, so a status check cannot start Claude Code's
 *     background self-update (nothing may run that the user did not ask for).
 * The executable's own folder goes first on PATH: an npm-installed CLI is a
 * `#!/usr/bin/env node` script, and a GUI-launched app's PATH often lacks the
 * node that sits next to it.
 */
export function buildProbeEnv(
  base: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (isInternalEnvKey(key)) continue;
    if (upper.startsWith('WMUX_')) continue;
    if (upper.startsWith('CODEX_') && upper !== 'CODEX_HOME') continue;
    out[key] = value;
  }
  out.DISABLE_AUTOUPDATER = '1';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dir = p.dirname(executable);
  const current = out[pathKey];
  out[pathKey] = current ? `${dir}${sep}${current}` : dir;
  return out;
}

/** Real runner: execFile with a hard timeout. Only the spawned child is killed. */
export const execProbe: ProbeRunner = (command, args, opts) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        command,
        args,
        {
          env: opts.env,
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_PROBE_OUTPUT,
          windowsHide: true,
          encoding: 'utf8',
          ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          const timedOut = Boolean(e?.killed);
          const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
          resolve({ code: timedOut ? null : code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut });
        },
      );
      child.stdin?.end();
    } catch {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false });
    }
  });

/**
 * Sign-in from a status probe: true / false, or null when it cannot be told.
 * Only the exit code and a single boolean (Claude) or the fixed "Not logged in"
 * line (Codex) are read; the rest of the output is dropped here.
 */
export function readLoginState(agent: AgentId, result: ProbeResult): boolean | null {
  if (result.timedOut || result.code === null) return null;
  if (agent === 'claude') {
    let loggedIn: unknown;
    try {
      loggedIn = (JSON.parse(result.stdout) as { loggedIn?: unknown } | null)?.loggedIn;
    } catch {
      return null;
    }
    if (loggedIn === true && result.code === 0) return true;
    if (loggedIn === false && result.code === 1) return false;
    return null;
  }
  if (result.code === 0) return true;
  if (result.code === 1 && /not logged in/i.test(`${result.stdout}\n${result.stderr}`)) return false;
  return null;
}

export class AgentSetupDetector {
  private readonly resolve: (agent: AgentId, env: NodeJS.ProcessEnv) => string | null;
  private readonly candidates: (agent: AgentId, env: NodeJS.ProcessEnv) => string[];
  private readonly run: ProbeRunner;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homedir: () => string;
  private readonly timeoutMs: number;
  /** Concurrent callers share one probe round instead of spawning twice. */
  private inflight: Promise<AgentSetupStatus[]> | null = null;

  constructor(deps: AgentSetupDetectorDeps = {}) {
    this.env = deps.env ?? (() => process.env);
    this.resolve = deps.resolve ?? ((agent, env) => resolveAgentExecutableWith(liveResolveEnv(env), agent));
    this.candidates = deps.candidates ?? ((agent, env) => agentCandidates(liveResolveEnv(env), agent));
    this.run = deps.run ?? execProbe;
    this.platform = deps.platform ?? process.platform;
    this.homedir = deps.homedir ?? os.homedir;
    this.timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  detectAll(): Promise<AgentSetupStatus[]> {
    if (!this.inflight) {
      this.inflight = Promise.all(AGENT_IDS.map((a) => this.detect(a))).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async detect(agent: AgentId): Promise<AgentSetupStatus> {
    const env = this.env();
    let executable: string | null = null;
    try {
      executable = this.resolve(agent, env);
    } catch {
      executable = null;
    }
    if (!executable) {
      let candidates: string[] = [];
      try {
        candidates = this.candidates(agent, env).slice(0, MAX_CANDIDATES);
      } catch {
        candidates = [];
      }
      return {
        agent,
        readiness: 'not-installed',
        executable: null,
        version: null,
        updateRecommended: false,
        loginKnown: true,
        candidates,
      };
    }

    const probeEnv = buildProbeEnv(env, executable, this.platform);
    const probe = (args: readonly string[]): Promise<ProbeResult> => {
      const launch = resolveClaudeLaunch(executable as string, { args, platform: this.platform });
      return this.run(launch.command, launch.args, {
        env: launch.env ? { ...probeEnv, ...launch.env } : probeEnv,
        // Never an opened repo: a project folder's config must not change the answer.
        cwd: this.homedir(),
        timeoutMs: this.timeoutMs,
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    };

    const [versionResult, statusResult] = await Promise.all([
      probe(['--version']),
      probe(STATUS_ARGS[agent]),
    ]);
    const version = versionResult.code === 0 ? parseAgentVersion(versionResult.stdout) : null;
    const loggedIn = readLoginState(agent, statusResult);
    return {
      agent,
      readiness: loggedIn === true ? 'ready' : 'login-needed',
      executable,
      version,
      updateRecommended: version !== null && isOlderVersion(version, AGENT_UPDATE_FLOORS[agent]),
      loginKnown: loggedIn !== null,
      candidates: [],
    };
  }
}
