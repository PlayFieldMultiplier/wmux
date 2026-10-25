// ─── Can a bot run on Hermes? (the bot profile's Engine line) ──────────────
//
// A bot on Hermes Agent runs through wmux's own Hermes home, so the profile
// asks main whether Hermes can run here — without a model turn
// (IPC.FACTORY_HERMES_READINESS, preload `factory.factoryHermesReadiness`) —
// while the bot is on Hermes or the owner is about to switch it there, and
// offers the one step that fixes the reason it cannot. The engine itself is
// changed through its own verb (`factory.setBotEngine`): the generic update
// refuses an engine change to ACP. A build whose preload lacks a verb shows
// the line without that part.
import { useCallback, useEffect, useRef, useState } from 'react';
import { HERMES_MCP_FIX_COMMAND, HERMES_VERSION_MIN, type HermesNotReadyReason, type HermesReadiness } from '../../../shared/hermesEngine';

/** The engines the profile's picker switches between. */
export type PickableEngine = 'claude-sdk' | 'hermes';

export interface HermesPort {
  /** Absent: this build cannot tell (the readiness row is not drawn).
   *  `fresh`: checked again in main, not its cached answer. */
  readiness?: (opts?: { fresh?: boolean }) => Promise<HermesReadiness>;
  /** Absent: no setup here. Opens Hermes's own model setup for wmux's Hermes
   *  home in a terminal tab; rejects with a plain message when none opens. */
  setup?: () => Promise<void>;
  /** Absent: the engine shows read-only. */
  setEngine?: (botId: string, engine: PickableEngine) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

interface HermesBridge {
  factoryHermesReadiness?: (opts?: { fresh?: boolean }) => Promise<unknown>;
  factoryHermesSetup?: () => Promise<void>;
  setBotEngine?: (botId: string, engine: PickableEngine) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

const REASONS: ReadonlySet<string> = new Set<HermesNotReadyReason>(['not-installed', 'outdated', 'unsupported', 'not-set-up', 'mcp-missing', 'config-mismatch', 'unknown']);

function shortText(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : undefined;
}

/** main's answer, checked (anything unreadable is "unknown"). Pure. */
export function readHermesReadiness(raw: unknown): HermesReadiness {
  if (!raw || typeof raw !== 'object') return { ready: false, reason: 'unknown' };
  const r = raw as Record<string, unknown>;
  const version = shortText(r.version, 40);
  if (r.ready === true) return { ready: true, ...(version ? { version } : {}) };
  const reason = typeof r.reason === 'string' && REASONS.has(r.reason) ? (r.reason as HermesNotReadyReason) : 'unknown';
  const message = shortText(r.message, 300);
  return { ready: false, reason, ...(version ? { version } : {}), ...(message ? { message } : {}) };
}

/** The preload's Hermes verbs, when this build has them. */
export function bridgeHermesPort(): HermesPort {
  const api = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI;
  const f = api?.factory && typeof api.factory === 'object' ? (api.factory as HermesBridge) : null;
  if (!f) return {};
  const readiness = f.factoryHermesReadiness;
  const setup = f.factoryHermesSetup;
  const setEngine = f.setBotEngine;
  return {
    ...(readiness ? { readiness: async (opts?: { fresh?: boolean }) => readHermesReadiness(await readiness(opts)) } : {}),
    ...(setup ? { setup: () => setup() } : {}),
    ...(setEngine ? { setEngine: (botId: string, engine: PickableEngine) => setEngine(botId, engine) } : {}),
  };
}

/** The one step a readiness answer offers: open the Hermes page, start the
 *  setup, or ask again once the owner ran a command. */
export type HermesFix = 'install' | 'setup' | 'recheck';

export interface HermesReadinessView {
  /** The line's i18n key and its values. */
  key: string;
  vars: Record<string, string>;
  fix?: HermesFix;
  /** A command the owner runs, shown as code with Copy. */
  command?: string;
  /** Raw detail behind a toggle. */
  detail?: string;
}

/** "0.22.x": the release line wmux was tested with. */
const TESTED_LINE = `${HERMES_VERSION_MIN.split('.').slice(0, 2).join('.')}.x`;

/** What the readiness row says for an answer, and its one fix. Pure. */
export function hermesReadinessView(r: HermesReadiness): HermesReadinessView {
  const version = r.version ?? '—';
  if (r.ready) return r.version ? { key: 'botsPage.hermes.ready', vars: { version: r.version } } : { key: 'botsPage.hermes.readyNoVersion', vars: {} };
  switch (r.reason) {
    case 'not-installed': return { key: 'botsPage.hermes.notInstalled', vars: {}, fix: 'install' };
    case 'outdated': return { key: 'botsPage.hermes.outdated', vars: { version, min: HERMES_VERSION_MIN }, fix: 'recheck' };
    case 'unsupported': return { key: 'botsPage.hermes.unsupported', vars: { version, tested: TESTED_LINE }, fix: 'recheck' };
    case 'not-set-up': return { key: 'botsPage.hermes.notSetUp', vars: {}, fix: 'setup' };
    case 'mcp-missing': return { key: 'botsPage.hermes.mcpMissing', vars: {}, fix: 'recheck', command: HERMES_MCP_FIX_COMMAND };
    case 'config-mismatch': return { key: 'botsPage.hermes.configMismatch', vars: {}, fix: 'recheck' };
    default: return { key: 'botsPage.hermes.unknown', vars: {}, fix: 'recheck', ...(r.message ? { detail: r.message } : {}) };
  }
}

/** How often the profile asks again while Hermes is not ready (the fix
 *  happens outside the app). */
const POLL_MS = 4_000;

/** Hermes's readiness while `active`: asked when it turns on, when the window
 *  comes back, and every few seconds until ready. null: not answered yet (or
 *  this build cannot tell). */
export function useHermesReadiness(ask: HermesPort['readiness'], active: boolean): {
  readiness: HermesReadiness | null;
  checking: boolean;
  recheck: () => void;
} {
  const [readiness, setReadiness] = useState<HermesReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const run = useCallback((shown: boolean) => {
    if (!ask) return;
    const mine = ++seq.current;
    if (shown) setChecking(true);
    // The owner's Check again is answered afresh; the polling may be cached.
    ask(shown ? { fresh: true } : undefined).then(
      (r) => { if (mine === seq.current) setReadiness(r); },
      () => { if (mine === seq.current) setReadiness({ ready: false, reason: 'unknown' }); },
    ).finally(() => { if (mine === seq.current) setChecking(false); });
  }, [ask]);
  const recheck = useCallback(() => run(true), [run]);
  useEffect(() => {
    if (!active) return undefined;
    run(false);
    const onFocus = () => run(false);
    window.addEventListener('focus', onFocus);
    return () => {
      seq.current += 1;
      setChecking(false);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, run]);
  const ready = readiness?.ready === true;
  useEffect(() => {
    if (!active || ready || !ask) return undefined;
    const timer = window.setInterval(() => run(false), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, ready, ask, run]);
  return { readiness, checking, recheck };
}
