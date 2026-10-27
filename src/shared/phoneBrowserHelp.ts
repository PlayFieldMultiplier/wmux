// ─── Browser help requests, as the phone sees and answers them
//
//   GET  /api/browser-help                          → 200 {requests:[…]}
//   POST /api/browser-help/:requestId/decision      {outcome} → 200 {requestId, state}
//   SSE  event: browser.help on /api/events          {phase, requestId, workspaceId, surfaceId?, deadlineAt, state?}
//
// The requests live in Electron main (browser-session/HelpRequests.ts). Main
// publishes the whole open table to the daemon over `daemon.browserHelp.set`
// on every change and on every daemon connect; the daemon serves the list
// from that table with no round trip, and asks main over the desktop bridge
// only for a decision (`workspaces.browserHelpDecide`). Contract in
// docs/phone-client-contract.md, "Browser help requests".
//
// The prompt is agent-written: it is sanitized again on every boundary it
// crosses (`sanitizeHelpPrompt`) and never rides in an SSE frame or a push.

import { BROWSER_HELP_MAX_TIMEOUT_MS, sanitizeHelpPrompt, type BrowserHelpOutcome, type BrowserHelpState } from './browserHelp';
import { isBrainPtyId } from './constants';

/** Announced at `daemon.phone.register`: this desktop publishes the table. */
export const BROWSER_HELP_CAPABILITY = 'browser.help';
/** The decision command. Not `browser.`-prefixed: main routes those to the page preview. */
export const PHONE_BROWSER_HELP_DECIDE_COMMAND = 'workspaces.browserHelpDecide';
/** Main → daemon: the open table. First-party, and only from the bridge owner. */
export const BROWSER_HELP_SET_METHOD = 'daemon.browserHelp.set';

/** Which browser the request is about. */
export type PhoneBrowserHelpBackend = 'builtin' | 'chrome' | 'live';

/** One open request: the fields main's table and the phone's list share. */
export interface PhoneBrowserHelpRow {
  requestId: string;
  workspaceId: string;
  surfaceId?: string;
  /** Agent-written, sanitized. Render as text only. */
  prompt: string;
  createdAt: number;
  deadlineAt: number;
  backend: PhoneBrowserHelpBackend;
  /** The phone's page preview can show this request's tab. */
  previewable: boolean;
  /** `scheme://host[:port]` of the tab when the desktop listed it; absent when unknown. */
  origin?: string;
}

/**
 * One row as `GET /api/browser-help` serves it. `sessionId` is the requesting
 * pane's `id` in `/api/sessions`, added by the daemon on that route only (when
 * that list has the pane, and never for a brain pane); never in main's table,
 * an SSE frame or a push.
 */
export type PhoneBrowserHelpServedRow = PhoneBrowserHelpRow & { sessionId?: string };

/**
 * One row as main sends it to the daemon: the phone row plus the pane whose
 * agent asked, which the daemon keeps to itself (a brain pane's request is
 * answered at the desktop) and never serves.
 */
export interface BrowserHelpTableRow extends PhoneBrowserHelpRow {
  requesterPtyId?: string;
}

/** The `browser.help` SSE frame. Never carries the prompt. */
export interface PhoneBrowserHelpFrame {
  phase: 'open' | 'close';
  requestId: string;
  workspaceId: string;
  surfaceId?: string;
  deadlineAt: number;
  /** close only, when main said how it ended. */
  state?: Exclude<BrowserHelpState, 'pending'>;
}

/** The codes main answers a decision with. (`browser-help-disabled` is the daemon's own 403.) */
export const BROWSER_HELP_ERROR_CODES = ['browser-help-not-found', 'browser-help-closed'] as const;
export type BrowserHelpErrorCode = (typeof BROWSER_HELP_ERROR_CODES)[number];

/** Main's reply to the decision command (inside an ok:true bridge reply).
 *  `unavailable`: main's store is not up yet; `invalid`: the daemon sent a
 *  payload main does not take. */
export type PhoneBrowserHelpDecideReply =
  | { state: BrowserHelpOutcome }
  | { error: BrowserHelpErrorCode }
  | { unavailable: true }
  | { invalid: true };

/** Rows one table may carry: 16 workspaces at HelpRequests' 8 pending each,
 *  about 100 KiB at the longest prompts, well inside the pipe's line limit.
 *  Main sends the oldest this many. */
export const BROWSER_HELP_MAX_ROWS = 128;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ORIGIN_RE = /^https?:\/\/[^/?#\s@]{1,253}$/;
const BACKENDS: readonly PhoneBrowserHelpBackend[] = ['builtin', 'chrome', 'live'];

export function isBrowserHelpId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** `scheme://host[:port]` of an http(s) URL, or undefined for anything else. */
export function browserHelpOrigin(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return ORIGIN_RE.test(parsed.origin) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function epochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** One row, or null when any field is out of shape. Unlisted keys are dropped. */
export function parseBrowserHelpRow(raw: unknown): BrowserHelpTableRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isBrowserHelpId(r.requestId) || !isBrowserHelpId(r.workspaceId)) return null;
  if (r.surfaceId !== undefined && !isBrowserHelpId(r.surfaceId)) return null;
  const prompt = sanitizeHelpPrompt(r.prompt);
  if (!prompt) return null;
  if (!epochMs(r.createdAt) || !epochMs(r.deadlineAt) || r.deadlineAt < r.createdAt) return null;
  if (r.deadlineAt - r.createdAt > BROWSER_HELP_MAX_TIMEOUT_MS) return null;
  if (typeof r.backend !== 'string' || !(BACKENDS as readonly string[]).includes(r.backend)) return null;
  if (typeof r.previewable !== 'boolean') return null;
  if (r.origin !== undefined && (typeof r.origin !== 'string' || !ORIGIN_RE.test(r.origin))) return null;
  if (r.requesterPtyId !== undefined && !isBrowserHelpId(r.requesterPtyId)) return null;
  const backend = r.backend as PhoneBrowserHelpBackend;
  const brain = isBrainPtyId(r.requesterPtyId as string | undefined);
  return {
    requestId: r.requestId,
    workspaceId: r.workspaceId,
    ...(r.surfaceId !== undefined ? { surfaceId: r.surfaceId as string } : {}),
    prompt,
    createdAt: r.createdAt,
    deadlineAt: r.deadlineAt,
    backend,
    // Never previewable on Live Chrome (the user's own browser), nor for a
    // brain pane's request (answered at the desktop).
    previewable: backend === 'live' || brain ? false : r.previewable,
    ...(r.origin !== undefined ? { origin: r.origin as string } : {}),
    ...(r.requesterPtyId !== undefined ? { requesterPtyId: r.requesterPtyId as string } : {}),
  };
}

/** The whole table, or null when it is not an array, too long, or any row is out of shape. */
export function parseBrowserHelpRows(raw: unknown): BrowserHelpTableRow[] | null {
  if (!Array.isArray(raw) || raw.length > BROWSER_HELP_MAX_ROWS) return null;
  const rows: BrowserHelpTableRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = parseBrowserHelpRow(item);
    if (!row || seen.has(row.requestId)) return null;
    seen.add(row.requestId);
    rows.push(row);
  }
  return rows;
}

/** The `browser.help` SSE data for one frame, from an allowlist: never a prompt. */
export function browserHelpFrameJson(frame: PhoneBrowserHelpFrame): string {
  return JSON.stringify({
    phase: frame.phase,
    requestId: frame.requestId,
    workspaceId: frame.workspaceId,
    ...(frame.surfaceId !== undefined ? { surfaceId: frame.surfaceId } : {}),
    deadlineAt: frame.deadlineAt,
    ...(frame.phase === 'close' && frame.state !== undefined ? { state: frame.state } : {}),
  });
}

const SETTLED_STATES: readonly string[] = ['completed', 'continued', 'cancelled', 'timed_out'];

/**
 * The table's optional `closed` list: how recently settled requests ended,
 * which the daemon attaches to the close frame of a row that just left. Only
 * a label, so a malformed entry is dropped rather than refusing the table.
 */
export function parseBrowserHelpClosed(raw: unknown): Map<string, Exclude<BrowserHelpState, 'pending'>> {
  const closed = new Map<string, Exclude<BrowserHelpState, 'pending'>>();
  if (!Array.isArray(raw)) return closed;
  for (const item of raw.slice(0, BROWSER_HELP_MAX_ROWS * 2)) {
    const r = item as { requestId?: unknown; state?: unknown } | null;
    if (r && isBrowserHelpId(r.requestId) && typeof r.state === 'string' && SETTLED_STATES.includes(r.state)) {
      closed.set(r.requestId, r.state as Exclude<BrowserHelpState, 'pending'>);
    }
  }
  return closed;
}

/** `POST …/decision` body: exactly `{outcome}`; anything else is null (400). */
export function parseBrowserHelpDecideBody(raw: unknown): { outcome: BrowserHelpOutcome } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'outcome') return null;
  const outcome = (raw as { outcome?: unknown }).outcome;
  return outcome === 'continued' || outcome === 'cancelled' ? { outcome } : null;
}

/** Main's decision reply, or null when out of shape. */
export function parseBrowserHelpDecideReply(raw: unknown): PhoneBrowserHelpDecideReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.unavailable === true) return { unavailable: true };
  if (r.invalid === true) return { invalid: true };
  if (typeof r.error === 'string') {
    return (BROWSER_HELP_ERROR_CODES as readonly string[]).includes(r.error) ? { error: r.error as BrowserHelpErrorCode } : null;
  }
  return r.state === 'continued' || r.state === 'cancelled' ? { state: r.state } : null;
}
