// ─── The Hermes engine host — one per app run ──────────────────────────────
//
// Holds what every Hermes bot shares (hermesEngine.ts has the reasons):
// wmux's Hermes home R, the gateway PIDs wmux saw start in this run, and the
// live Hermes adapters. It answers readiness (FACTORY_HERMES_READINESS),
// builds each adapter's policy (AcpBrainAdapter `hermes`), and on app quit
// lets every adapter's turn settle, then stops R's gateway.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { BotBinding } from '../../shared/bot';
import type { HermesReadiness } from '../../shared/hermesEngine';
import type { AcpBrainAdapter, AcpHermesPolicy } from '../deck/AcpBrainAdapter';
import { waitForCommanderTokenUse } from '../deck/commanderTrust';
import { getApprovalService } from './approvals';
import { getWmuxDir } from '../../daemon/config';
import {
  hermesEnv,
  hermesHasModel,
  hermesConfigGet,
  hermesNotReadyMessage,
  hermesReadiness,
  hermesRoot,
  hermesSetupLine,
  hermesToolAllowed,
  isHermesGatewayOf,
  probeHermesMcp,
  readHermesGatewayState,
  resolveHermesExecutable,
  runHermes,
  type HermesProbeResult,
  type HermesRun,
} from './hermesEngine';

/** How long the owner has to answer a Hermes permission card (Hermes's own
 *  approvals.timeout, 300 s, is the backstop behind it). */
export const HERMES_PERMISSION_TIMEOUT_MS = 240_000;
/** How long a new session's MCP child may take to call main. */
const MCP_READY_MS = 15_000;
/** How long a readiness answer serves the profile's polling. A spawn always
 *  checks afresh. */
const READINESS_CACHE_MS = 15_000;
/** App quit (bounded by index.ts HERMES_SHUTDOWN_TIMEOUT_MS): how long the
 *  turns get to settle, then how long Hermes's own gateway stop gets before
 *  the gateway's PID is signalled. */
const QUIT_SETTLE_MS = 4_000;
const QUIT_STOP_MS = 2_500;

export interface HermesHostDeps {
  wmuxDir: () => string;
  resolveExe?: () => string | null;
  run?: HermesRun;
  probe?: (exe: string, env: Record<string, string>) => Promise<HermesProbeResult>;
  /** Signal a PID (default process.kill; Windows: taskkill /T /F). */
  kill?: (pid: number) => void;
  pidAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultKill(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

export class HermesHost {
  /** Gateway PIDs of R that wmux saw start after its own spawn, this run. */
  private readonly owned = new Set<number>();
  private readonly adapters = new Set<AcpBrainAdapter>();
  private readonly run: HermesRun;
  private readonly log: (line: string) => void;
  private readonly pidAlive: (pid: number) => boolean;
  private stopping: Promise<void> | null = null;
  private cached: { at: number; value: HermesReadiness } | null = null;
  private inFlight: Promise<HermesReadiness> | null = null;

  constructor(private readonly deps: HermesHostDeps) {
    this.run = deps.run ?? runHermes;
    this.log = deps.log ?? ((l) => console.log(l));
    this.pidAlive = deps.pidAlive ?? defaultPidAlive;
  }

  root(): string {
    return hermesRoot(this.deps.wmuxDir());
  }

  env(): Record<string, string> {
    return hermesEnv(this.root());
  }

  exe(): string | null {
    return (this.deps.resolveExe ?? (() => resolveHermesExecutable()))();
  }

  /** Whether a Hermes bot can run here (writes R's settings when wrong).
   *  `fresh`: never the cached answer (a spawn). */
  async readiness(fresh = false): Promise<HermesReadiness> {
    if (!fresh && this.cached && Date.now() - this.cached.at < READINESS_CACHE_MS) return this.cached.value;
    // One check at a time: a spawn and the profile's poll share it.
    if (!this.inFlight) {
      this.inFlight = this.check().then((value) => {
        this.cached = { at: Date.now(), value };
        return value;
      }).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async check(): Promise<HermesReadiness> {
    await this.ensureOwnGateway();
    return hermesReadiness({
      root: this.root(),
      resolveExe: () => this.exe(),
      run: this.run,
      env: (root) => hermesEnv(root),
      probe: this.deps.probe ?? ((exe, env) => probeHermesMcp(exe, env, { onSessionStarted: () => this.markOwned() })),
      stamp: (exe) => {
        try {
          return String(fs.statSync(exe).mtimeMs);
        } catch {
          return '';
        }
      },
    });
  }

  /** The setup tab's line for `shell`, or null (no hermes, or a path that
   *  cannot be typed there). */
  setupLine(platform: NodeJS.Platform, shell: string | undefined): string | null {
    const exe = this.exe();
    if (!exe) return null;
    fs.mkdirSync(this.root(), { recursive: true, mode: 0o700 });
    return hermesSetupLine(platform, shell, exe, this.env());
  }

  /** Whether R has a model (the setup landed). */
  async hasModel(): Promise<boolean> {
    const exe = this.exe();
    if (!exe) return false;
    try {
      return hermesHasModel(await hermesConfigGet(this.run, exe, this.env(), 'model'));
    } catch {
      return false;
    }
  }

  // ── the gateway ──

  /** Record R's running gateway as wmux's (it started after wmux's spawn). */
  markOwned(): void {
    const state = readHermesGatewayState(this.root());
    if (state && this.pidAlive(state.pid) && isHermesGatewayOf(this.root(), state)) this.owned.add(state.pid);
  }

  /** Before a Hermes process attaches: a running gateway of R that wmux did
   *  not see start this run, or that a viewer did not auto-start
   *  (`--idle-exit`), is stopped, so the next one starts with wmux's
   *  environment. Not while a bot's agent is attached: that gateway was
   *  started by wmux's own viewer, and a stop would end its turn. */
  async ensureOwnGateway(): Promise<void> {
    const state = readHermesGatewayState(this.root());
    if (!state || !this.pidAlive(state.pid)) return;
    if ([...this.adapters].some((a) => a.agentLive())) {
      this.markOwned();
      return;
    }
    if (this.owned.has(state.pid) && state.argv.includes('--idle-exit')) return;
    this.log(`[hermes] restarting a gateway of wmux's Hermes home that wmux did not start (pid ${state.pid})`);
    await this.stopGateway();
  }

  /** Stop R's gateway: Hermes's own stop (which interrupts live sessions,
   *  `--yes`), then its PID once gateway_state.json says it is R's. */
  async stopGateway(stopMs = 15_000): Promise<void> {
    const root = this.root();
    const before = readHermesGatewayState(root);
    if (!before || !this.pidAlive(before.pid)) return;
    const exe = this.exe();
    if (exe) await this.run(exe, ['gateway', 'stop', '--yes'], { env: this.env(), timeoutMs: stopMs });
    for (let i = 0; i < Math.ceil(stopMs / 3 / 250) && this.pidAlive(before.pid); i++) await new Promise((r) => setTimeout(r, 250));
    const still = readHermesGatewayState(root);
    if (still && still.pid === before.pid && this.pidAlive(still.pid) && isHermesGatewayOf(root, still)) {
      this.log(`[hermes] gateway ${still.pid} did not stop; signalling it`);
      try {
        (this.deps.kill ?? defaultKill)(still.pid);
      } catch (err) {
        this.log(`[hermes] could not signal gateway ${still.pid}: ${String(err)}`);
      }
    }
    this.owned.delete(before.pid);
  }

  // ── adapters ──

  /** The policy of one Hermes bot's adapter. */
  policyFor(binding: BotBinding): AcpHermesPolicy {
    return {
      prepare: async () => {
        const r = await this.readiness(true);
        if (!r.ready) return { ok: false, message: hermesNotReadyMessage(r) };
        return { ok: true, env: this.env() };
      },
      sessionStarted: () => {
        this.markOwned();
        const state = readHermesGatewayState(this.root());
        const platforms = state ? Object.keys(state.platforms) : [];
        return platforms.length > 0
          ? hermesNotReadyMessage({ ready: false, reason: 'config-mismatch', message: `its gateway runs messaging platforms (${platforms.slice(0, 3).join(', ')}).` })
          : null;
      },
      askOwner: async (req, signal) => {
        const approvals = getApprovalService();
        if (!approvals) return false;
        return approvals.askNativeTool(binding, req, { timeoutMs: HERMES_PERMISSION_TIMEOUT_MS, signal });
      },
      toolAllowed: hermesToolAllowed,
      mcpReady: (token, since) => waitForCommanderTokenUse(token, since, MCP_READY_MS),
      unsettled: () => this.stopGateway(),
      disposed: (adapter) => {
        this.adapters.delete(adapter);
      },
    };
  }

  register(adapter: AcpBrainAdapter): void {
    this.adapters.add(adapter);
  }

  /** App quit: every Hermes turn is cancelled and gets QUIT_SETTLE_MS to
   *  settle, then R's gateway is stopped when wmux started it (Hermes's stop
   *  interrupts a turn still running). */
  shutdown(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        await Promise.race([
          Promise.allSettled([...this.adapters].map((a) => a.shutdown())),
          new Promise((r) => setTimeout(r, QUIT_SETTLE_MS)),
        ]);
        const state = readHermesGatewayState(this.root());
        if (state && this.owned.has(state.pid) && this.pidAlive(state.pid)) await this.stopGateway(QUIT_STOP_MS);
      })();
    }
    return this.stopping;
  }
}

let host: HermesHost | null = null;

export function setHermesHost(h: HermesHost | null): void {
  host = h;
}

/** The app's host (made on first use over wmux's data dir). */
export function getHermesHost(): HermesHost {
  host ??= new HermesHost({ wmuxDir: getWmuxDir });
  return host;
}
