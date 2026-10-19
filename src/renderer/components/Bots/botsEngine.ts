// ─── Can a new bot talk? (the Bots page's first screen) ─────────────────────
//
// A bot runs on the Claude engine, so before the first bot is started the
// page asks main whether that engine can sign in — without spending a model
// turn (IPC.FACTORY_ENGINE_READINESS, preload `factory.factoryEngineReadiness`)
// — and offers main's own Claude login (`factory.factoryEngineLogin`) when it
// cannot. A build whose preload has neither answers "unknown" here, which
// never blocks Start: the bot's own first turn then says what is wrong.
import { useCallback, useEffect, useRef, useState } from 'react';

export type EngineNotReadyReason = 'claude-not-installed' | 'claude-not-logged-in' | 'claude-unusable' | 'unknown';

export interface EngineReadiness {
  ready: boolean;
  reason?: EngineNotReadyReason;
  message?: string;
}

export interface EnginePort {
  /** Absent: this build cannot tell (never blocks Start). */
  readiness?: () => Promise<EngineReadiness>;
  /** Absent: no login here. Opens main's Claude login; resolves once it is open. */
  login?: () => Promise<void>;
}

interface EngineBridge {
  factoryEngineReadiness?: () => Promise<unknown>;
  factoryEngineLogin?: () => Promise<void>;
}

const REASONS: ReadonlySet<string> = new Set<EngineNotReadyReason>(['claude-not-installed', 'claude-not-logged-in', 'claude-unusable', 'unknown']);

/** main's answer, checked (anything unreadable is "unknown"). Pure. */
export function readReadiness(raw: unknown): EngineReadiness {
  if (!raw || typeof raw !== 'object') return { ready: false, reason: 'unknown' };
  const r = raw as Record<string, unknown>;
  if (r.ready === true) return { ready: true };
  const reason = typeof r.reason === 'string' && REASONS.has(r.reason) ? (r.reason as EngineNotReadyReason) : 'unknown';
  const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim().slice(0, 300) : undefined;
  return { ready: false, reason, ...(message ? { message } : {}) };
}

/** The preload's engine verbs, when this build has them. */
export function bridgeEnginePort(): EnginePort {
  const api = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI;
  const f = api?.factory && typeof api.factory === 'object' ? (api.factory as EngineBridge) : null;
  if (!f) return {};
  const readiness = f.factoryEngineReadiness;
  const login = f.factoryEngineLogin;
  return {
    ...(readiness ? { readiness: async () => readReadiness(await readiness()) } : {}),
    ...(login ? { login: () => login() } : {}),
  };
}

/** Whether the answer holds Start back: only a known reason does (an
 *  unknown answer lets the bot's first turn say what is wrong). Pure. */
export function blocksStart(r: EngineReadiness | null): boolean {
  return !!r && !r.ready && (r.reason === 'claude-not-installed' || r.reason === 'claude-not-logged-in' || r.reason === 'claude-unusable');
}

/** After a login opens, how often and how long the page asks again (the
 *  login finishes outside the app). */
const RECHECK_MS = 3_000;
const RECHECK_FOR_MS = 120_000;

/** The engine's readiness, asked on mount, when the window comes back and
 *  for a while after a login was opened. null: not answered (or this build
 *  cannot tell). */
export function useEngineReadiness(port: EnginePort): {
  readiness: EngineReadiness | null;
  checking: boolean;
  recheck: () => void;
  login: () => Promise<void>;
} {
  const [readiness, setReadiness] = useState<EngineReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const ask = port.readiness;
  const recheck = useCallback(() => {
    if (!ask) return;
    const mine = ++seq.current;
    setChecking(true);
    ask().then(
      (r) => { if (mine === seq.current) setReadiness(r); },
      () => { if (mine === seq.current) setReadiness({ ready: false, reason: 'unknown' }); },
    ).finally(() => { if (mine === seq.current) setChecking(false); });
  }, [ask]);
  useEffect(() => {
    recheck();
    window.addEventListener('focus', recheck);
    return () => {
      seq.current += 1;
      window.removeEventListener('focus', recheck);
    };
  }, [recheck]);
  const [loginAt, setLoginAt] = useState<number | null>(null);
  useEffect(() => {
    if (loginAt === null || readiness?.ready) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() - loginAt > RECHECK_FOR_MS) { window.clearInterval(timer); return; }
      recheck();
    }, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [loginAt, readiness?.ready, recheck]);
  const open = port.login;
  const login = useCallback(async () => {
    if (!open) return;
    await open();
    setLoginAt(Date.now());
    recheck();
  }, [open, recheck]);
  return { readiness, checking, recheck, login };
}
