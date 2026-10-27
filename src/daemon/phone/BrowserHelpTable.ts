// The daemon's copy of main's open browser help requests
// (shared/phoneBrowserHelp.ts). Main sends the whole table over
// `daemon.browserHelp.set` on every change and on every connect; this holds
// the last one, serves `GET /api/browser-help` from it, and turns each change
// into `browser.help` open / close frames for the phone's live event stream.
//
// What it trusts:
//   - Only the registered desktop (the phone bridge's owner, a first-party
//     client) may write the table. Anyone else is refused and nothing changes.
//   - The table belongs to the client that published it: when that client
//     disconnects the rows are closed and dropped, so a daemon running without
//     its desktop lists nothing.
//   - A row's workspace is the one a decision is sent for; the phone's request
//     never names one.

import {
  parseBrowserHelpClosed,
  parseBrowserHelpRows,
  type PhoneBrowserHelpFrame,
  type BrowserHelpTableRow,
} from '../../shared/phoneBrowserHelp';
import type { BrowserHelpState } from '../../shared/browserHelp';

/** Closed ids remembered so a late decision answers "closed", not "not found". */
const RECENTLY_CLOSED_MAX = 64;

type Settled = Exclude<BrowserHelpState, 'pending'>;

export interface BrowserHelpTableOptions {
  /** The client is first-party (main's own process). */
  firstParty: (clientId: string) => boolean;
  /** The client is the registered desktop (DesktopPhoneBridge owner). */
  isOwner: (clientId: string) => boolean;
  /** The frames one change produced, in order. */
  emit: (frames: PhoneBrowserHelpFrame[]) => void;
  /**
   * The open rows after each accepted table and each decision taken here,
   * with how the rows that left ended when known: the phone push
   * (push/browserHelpPush.ts). Not called when the publisher disconnects.
   * A throw is logged, never passed to the table's caller.
   */
  onRows?: (rows: readonly BrowserHelpTableRow[], closed: ReadonlyMap<string, Settled>) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Injectable clock. */
  now?: () => number;
}

/** A closed request names its workspace and tab, so a caller can answer one it does not own as unknown. */
type ClosedHelp = { closed: true; workspaceId: string; surfaceId?: string };
export type BrowserHelpLookup = { row: BrowserHelpTableRow } | ClosedHelp | null;

function closedOf(row: BrowserHelpTableRow): ClosedHelp {
  return { closed: true, workspaceId: row.workspaceId, ...(row.surfaceId !== undefined ? { surfaceId: row.surfaceId } : {}) };
}

export class BrowserHelpTable {
  private rows = new Map<string, BrowserHelpTableRow>();
  private publisher: string | null = null;
  private readonly recentlyClosed = new Map<string, ClosedHelp>();
  /** Ids a decision through this daemon settled: never listed again, even by a table main computed before it. */
  private readonly decided = new Set<string>();

  constructor(private readonly opts: BrowserHelpTableOptions) {}

  /** `daemon.browserHelp.set` `{requests:[…], closed?:[{requestId, state}]}`. */
  set(clientId: string, params: unknown): { ok: boolean; error?: string; accepted?: number } {
    if (!this.opts.firstParty(clientId) || !this.opts.isOwner(clientId)) {
      this.opts.log?.('warn', `[browser-help] refused a table from ${clientId}: not the registered desktop`);
      return { ok: false, error: 'daemon.browserHelp.set is accepted from the registered desktop only' };
    }
    const p = params as { requests?: unknown; closed?: unknown } | undefined;
    const rows = parseBrowserHelpRows(p?.requests);
    if (!rows) return { ok: false, error: 'daemon.browserHelp.set requires a valid requests array' };
    const states = parseBrowserHelpClosed(p?.closed);
    const next = new Map(rows.filter((row) => !this.decided.has(row.requestId)).map((row) => [row.requestId, row]));
    const frames: PhoneBrowserHelpFrame[] = [];
    for (const [id, row] of this.rows) {
      if (!next.has(id)) frames.push(this.closeFrame(row, states.get(id)));
    }
    for (const [id, row] of next) {
      if (this.rows.has(id)) continue;
      this.recentlyClosed.delete(id);
      frames.push(frameOf('open', row));
    }
    this.rows = next;
    this.publisher = clientId;
    if (frames.length) this.opts.emit(frames);
    this.notifyRows([...next.values()], states);
    return { ok: true, accepted: rows.length };
  }

  /** A pipe client went away: its table goes with it. */
  onClientClose(clientId: string): void {
    if (this.publisher === null || this.publisher !== clientId) return;
    const frames = [...this.rows.values()].map((row) => this.closeFrame(row, undefined));
    this.rows = new Map();
    this.publisher = null;
    if (frames.length) this.opts.emit(frames);
  }

  /** Whether a desktop has published a table that still stands. */
  get published(): boolean {
    return this.publisher !== null;
  }

  /**
   * The open rows. One past its deadline is left out even before main's
   * next table says so (main's timer can be late, as after a sleep): main
   * would only answer it as closed.
   */
  list(): BrowserHelpTableRow[] {
    const at = this.now();
    return [...this.rows.values()].filter((row) => row.deadlineAt > at);
  }

  lookup(requestId: string): BrowserHelpLookup {
    const row = this.rows.get(requestId);
    if (row) return row.deadlineAt > this.now() ? { row } : closedOf(row);
    return this.recentlyClosed.get(requestId) ?? null;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** A decision through this daemon settled the request: close its row now. */
  closeDecided(requestId: string, state: Settled): void {
    const row = this.rows.get(requestId);
    if (!row) return;
    this.decided.add(requestId);
    while (this.decided.size > RECENTLY_CLOSED_MAX) this.decided.delete(this.decided.values().next().value as string);
    this.rows.delete(requestId);
    this.opts.emit([this.closeFrame(row, state)]);
    this.notifyRows([...this.rows.values()], new Map([[requestId, state]]));
  }

  private notifyRows(rows: BrowserHelpTableRow[], closed: ReadonlyMap<string, Settled>): void {
    try {
      this.opts.onRows?.(rows, closed);
    } catch (error) {
      this.opts.log?.('warn', `[browser-help] push routing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private closeFrame(row: BrowserHelpTableRow, state: Settled | undefined): PhoneBrowserHelpFrame {
    this.recentlyClosed.set(row.requestId, closedOf(row));
    while (this.recentlyClosed.size > RECENTLY_CLOSED_MAX) {
      this.recentlyClosed.delete(this.recentlyClosed.keys().next().value as string);
    }
    return { ...frameOf('close', row), ...(state ? { state } : {}) };
  }
}

/** The frame for one row, built from an allowlist: never the prompt. */
function frameOf(phase: 'open' | 'close', row: BrowserHelpTableRow): PhoneBrowserHelpFrame {
  return {
    phase,
    requestId: row.requestId,
    workspaceId: row.workspaceId,
    ...(row.surfaceId !== undefined ? { surfaceId: row.surfaceId } : {}),
    deadlineAt: row.deadlineAt,
  };
}
