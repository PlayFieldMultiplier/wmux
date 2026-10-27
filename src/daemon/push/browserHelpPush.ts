// A browser help request (an agent handing a sign-in, a CAPTCHA or a payment
// step back to the human), as a push to the phone, and the retraction once it
// closes. Driven by the daemon's copy of main's open table
// (phone/BrowserHelpTable.ts), the same source as the `browser.help` frames.
//
// Who is pushed: only a device that can answer it from the app, which is the
// rule of the decision route (web/browserHelp.ts): the server runs with the
// transcript consent and `--allow-input`, the device listed the
// `browserHelpPush` capability, and its input grant is on and was set
// explicitly. A read-only device gets nothing. A brain pane's request is never
// pushed: it is answered at the desktop, so the phone could only dead-end.
//
// The title and body are fixed text. The prompt is the agent's to write, so it
// stays in the app (and off the lock screen), and the workspace name is left
// out with it.

import type { PushPayload } from '../../shared/push/pushEnvelope';
import type { BrowserHelpState } from '../../shared/browserHelp';
import type { BrowserHelpTableRow } from '../../shared/phoneBrowserHelp';
import { BROWSER_HELP_MAX_ROWS } from '../../shared/phoneBrowserHelp';
import { APPROVAL_RETRACTION_KIND } from './approvalPushPayload';
import type { PushTarget } from './PushSender';

/** Listed at `POST /api/push-registration` by an app that can open these. */
export const BROWSER_HELP_PUSH_CAPABILITY = 'browserHelpPush';

/** Park-queue keys, kept apart from every other kind's. */
export const BROWSER_HELP_PARK_PREFIX = 'browserhelp:';

export type BrowserHelpResolution = Exclude<BrowserHelpState, 'pending'>;

/** Ids remembered as already handled, so a stale or repeated table never pushes one twice. */
const HANDLED_MAX = BROWSER_HELP_MAX_ROWS * 4;

export function buildBrowserHelpPushPayload(row: BrowserHelpTableRow): PushPayload {
  return {
    title: 'Browser help needed',
    body: 'An agent is waiting for you to finish a step in the browser.',
    approvalKind: 'browser_help',
    browserHelpId: row.requestId,
    workspaceId: row.workspaceId,
    ...(row.surfaceId !== undefined ? { surfaceId: row.surfaceId } : {}),
    // Answered on the request's card in the app, never from the lock screen.
    requiresInAppChoice: true,
  };
}

/** One banner per request. */
export function browserHelpPushCollapseId(requestId: string): string {
  return `bh-${requestId}`.slice(0, 64);
}

/** Replaces the request's banner once it closes. No `approvalId` and no
 *  `browserHelpId`: an extension that saw one would put the card back. */
export function buildBrowserHelpRetractionPayload(
  requestId: string,
  workspaceId: string,
  resolution: BrowserHelpResolution,
): PushPayload {
  return {
    title: 'Browser help closed',
    body: 'No longer waiting — nothing to do.',
    kind: APPROVAL_RETRACTION_KIND,
    approvalKind: 'browser_help',
    retractsApprovalId: requestId,
    workspaceId,
    resolution,
  };
}

/**
 * The devices a browser help push goes to: the decision route's rule. The
 * server-wide flags are those of the running web server (none running: no
 * phone can answer, so nobody), and the desktop must take a phone's decision.
 */
export function browserHelpPushAudience(input: {
  server: { allowInput: boolean; allowTranscript: boolean } | undefined;
  desktopDecides: boolean;
  targets: readonly PushTarget[];
  hasExplicitInputGrant: (deviceId: string) => boolean;
}): string[] {
  if (input.server?.allowTranscript !== true || input.server.allowInput !== true || !input.desktopDecides) return [];
  return input.targets
    .filter((t) => t.push.capabilities?.includes(BROWSER_HELP_PUSH_CAPABILITY) === true)
    .filter((t) => input.hasExplicitInputGrant(t.deviceId))
    .map((t) => t.deviceId);
}

export interface BrowserHelpPushRouterDeps {
  /** The devices that may be pushed right now (browserHelpPushAudience). */
  audience: () => string[];
  /** Whether the requesting pane is a brain pane. */
  isBrainPane: (ptyId: string) => boolean;
  /** Is presence holding this payload back? */
  suppress: (payload: PushPayload) => boolean;
  /** `yields`: a help push never costs an approval its place in a queue. */
  send: (payload: PushPayload, opts: { collapseId: string; requires: string; deviceIds: readonly string[]; yields: true }) => void;
  park: (key: string, payload: PushPayload, collapseId: string, requires: string, deviceIds: readonly string[]) => void;
  forget: (key: string) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pushed {
  /** parked: held by presence; sent: on the phone; dropped: evicted unsent. */
  state: 'parked' | 'sent' | 'dropped';
  workspaceId: string;
  deadlineAt: number;
  /** The devices it went (or will go) to; its retraction goes to the same. */
  deviceIds: string[];
  /** Set while no desktop lists it: retracts it at its deadline. */
  orphanTimer?: unknown;
}

/**
 * The daemon's open browser help table, as pushes and retractions. Each
 * table is diffed against what was pushed, so a republish of the same rows
 * (a reconnect, main's next change) sends nothing. A request is pushed at
 * most once: when it first appears, or at a later table if no device could
 * answer it before. A brain pane's, or one past its deadline, is skipped for
 * good.
 */
export class BrowserHelpPushRouter {
  private readonly pushed = new Map<string, Pushed>();
  private readonly handled = new Set<string>();

  constructor(private readonly deps: BrowserHelpPushRouterDeps) {}

  /** The open rows, and how the rows that left ended when main said. */
  set(rows: readonly BrowserHelpTableRow[], closed: ReadonlyMap<string, BrowserHelpResolution>): void {
    const { deps } = this;
    const now = (deps.now ?? Date.now)();
    const open = new Set(rows.map((row) => row.requestId));
    for (const [id, record] of [...this.pushed]) {
      if (!open.has(id)) this.close(id, record, closed.get(id), now);
      else this.adopt(record);
    }
    let audience: string[] | undefined;
    for (const row of rows) {
      const id = row.requestId;
      if (this.pushed.has(id) || this.handled.has(id)) continue;
      if (row.deadlineAt <= now || (row.requesterPtyId !== undefined && deps.isBrainPane(row.requesterPtyId))) {
        this.remember(id);
        continue;
      }
      // Nobody may answer it yet (no grant, no server): judged again at the
      // next table rather than skipped for good.
      audience ??= deps.audience();
      if (audience.length === 0) continue;
      this.remember(id);
      const deviceIds = audience;
      const payload = buildBrowserHelpPushPayload(row);
      const collapseId = browserHelpPushCollapseId(id);
      const record: Pushed = { state: 'sent', workspaceId: row.workspaceId, deadlineAt: row.deadlineAt, deviceIds };
      // Recorded before parking: a full park queue may drop it at once.
      this.pushed.set(id, record);
      if (deps.suppress(payload)) {
        record.state = 'parked';
        deps.park(BROWSER_HELP_PARK_PREFIX + id, payload, collapseId, BROWSER_HELP_PUSH_CAPABILITY, deviceIds);
      } else {
        deps.send(payload, { collapseId, requires: BROWSER_HELP_PUSH_CAPABILITY, deviceIds, yields: true });
      }
    }
  }

  /**
   * The desktop that published the table went away. Answering goes through
   * it, so a push never delivered (presence still holds it, or the park queue
   * dropped it) is forgotten and judged again if a desktop lists the request
   * once more. A sent one stays on the phone: a desktop that comes back and
   * lists it keeps it, one that comes back without it retracts it, and with
   * no desktop at all it is retracted as `timed_out` at its deadline. Called
   * before presence lets held pushes go.
   */
  publisherGone(): void {
    const { deps } = this;
    const now = (deps.now ?? Date.now)();
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    for (const [id, record] of [...this.pushed]) {
      if (record.state !== 'sent') {
        if (record.state === 'parked') deps.forget(BROWSER_HELP_PARK_PREFIX + id);
        this.pushed.delete(id);
        this.handled.delete(id);
        continue;
      }
      if (record.orphanTimer !== undefined) continue;
      record.orphanTimer = setTimer(() => {
        record.orphanTimer = undefined;
        if (this.pushed.get(id) === record) this.close(id, record, 'timed_out', (deps.now ?? Date.now)());
      }, Math.max(0, record.deadlineAt - now));
    }
  }

  /** A desktop lists it again: no longer retracted at its deadline. */
  private adopt(record: Pushed): void {
    if (record.orphanTimer === undefined) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(record.orphanTimer);
    record.orphanTimer = undefined;
  }

  private close(id: string, record: Pushed, state: BrowserHelpResolution | undefined, now: number): void {
    const { deps } = this;
    this.adopt(record);
    this.pushed.delete(id);
    if (record.state === 'parked') deps.forget(BROWSER_HELP_PARK_PREFIX + id);
    if (record.state !== 'sent') return;
    // A row that left with no state (a desktop that came back without it):
    // past its deadline it timed out, before it nobody answered it.
    const resolution = state ?? (now >= record.deadlineAt ? 'timed_out' : 'cancelled');
    deps.log?.('info', `[push] retracting the push for browser help ${id}`);
    deps.send(buildBrowserHelpRetractionPayload(id, record.workspaceId, resolution), {
      collapseId: browserHelpPushCollapseId(id),
      requires: BROWSER_HELP_PUSH_CAPABILITY,
      deviceIds: record.deviceIds,
      yields: true,
    });
  }

  /** Is this park-queue key one of ours? */
  owns(key: string): boolean {
    return key.startsWith(BROWSER_HELP_PARK_PREFIX);
  }

  /**
   * The devices a held push may still go to as presence releases it: those
   * it was parked for that the decision route still allows, and none once
   * its deadline passed. They become the devices its retraction goes to.
   * With none it is not sent, and the next table judges it again.
   */
  narrowRelease(requestId: string, deviceIds: readonly string[]): string[] {
    const record = this.pushed.get(requestId);
    if (record?.state !== 'parked') return [];
    const allowed = new Set(this.deps.audience());
    const narrowed = (this.deps.now ?? Date.now)() < record.deadlineAt ? deviceIds.filter((id) => allowed.has(id)) : [];
    if (narrowed.length === 0) {
      this.pushed.delete(requestId);
      this.handled.delete(requestId);
      return [];
    }
    record.deviceIds = narrowed;
    return narrowed;
  }

  /** The park queue released or evicted one of ours. */
  onParkedOutcome(key: string, outcome: 'delivered' | 'dropped'): void {
    const record = this.pushed.get(key.slice(BROWSER_HELP_PARK_PREFIX.length));
    if (record?.state !== 'parked') return;
    record.state = outcome === 'delivered' ? 'sent' : 'dropped';
  }

  private remember(id: string): void {
    this.handled.add(id);
    while (this.handled.size > HANDLED_MAX) this.handled.delete(this.handled.values().next().value as string);
  }
}
