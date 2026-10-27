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
 * phone can answer, so nobody).
 */
export function browserHelpPushAudience(input: {
  server: { allowInput: boolean; allowTranscript: boolean } | undefined;
  targets: readonly PushTarget[];
  hasExplicitInputGrant: (deviceId: string) => boolean;
}): string[] {
  if (input.server?.allowTranscript !== true || input.server.allowInput !== true) return [];
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
  send: (payload: PushPayload, opts: { collapseId: string; requires: string; deviceIds: readonly string[] }) => void;
  park: (key: string, payload: PushPayload, collapseId: string, requires: string, deviceIds: readonly string[]) => void;
  forget: (key: string) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
  now?: () => number;
}

interface Pushed {
  /** parked: held by presence; sent: on the phone; dropped: evicted unsent. */
  state: 'parked' | 'sent' | 'dropped';
  workspaceId: string;
  deadlineAt: number;
  /** The devices it went (or will go) to; its retraction goes to the same. */
  deviceIds: readonly string[];
}

/**
 * The daemon's open browser help table, as pushes and retractions. Each
 * table is diffed against what was pushed, so a republish of the same rows
 * (a reconnect, main's next change) sends nothing. Each request is judged
 * once, when it first appears: pushed, or skipped for good (no device may
 * answer it, a brain pane's, already past its deadline).
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
      if (open.has(id)) continue;
      this.pushed.delete(id);
      if (record.state === 'parked') deps.forget(BROWSER_HELP_PARK_PREFIX + id);
      if (record.state !== 'sent') continue;
      // A row that left with no state (the desktop that held it is gone):
      // past its deadline it timed out, before it nobody answered it.
      const resolution = closed.get(id) ?? (now >= record.deadlineAt ? 'timed_out' : 'cancelled');
      deps.log?.('info', `[push] retracting the push for browser help ${id}`);
      deps.send(buildBrowserHelpRetractionPayload(id, record.workspaceId, resolution), {
        collapseId: browserHelpPushCollapseId(id),
        requires: BROWSER_HELP_PUSH_CAPABILITY,
        deviceIds: record.deviceIds,
      });
    }
    for (const row of rows) {
      const id = row.requestId;
      if (this.pushed.has(id) || this.handled.has(id)) continue;
      this.remember(id);
      if (row.deadlineAt <= now) continue;
      if (row.requesterPtyId !== undefined && deps.isBrainPane(row.requesterPtyId)) continue;
      const deviceIds = deps.audience();
      if (deviceIds.length === 0) continue;
      const payload = buildBrowserHelpPushPayload(row);
      const collapseId = browserHelpPushCollapseId(id);
      const record: Pushed = { state: 'sent', workspaceId: row.workspaceId, deadlineAt: row.deadlineAt, deviceIds };
      if (deps.suppress(payload)) {
        deps.park(BROWSER_HELP_PARK_PREFIX + id, payload, collapseId, BROWSER_HELP_PUSH_CAPABILITY, deviceIds);
        record.state = 'parked';
      } else {
        deps.send(payload, { collapseId, requires: BROWSER_HELP_PUSH_CAPABILITY, deviceIds });
      }
      this.pushed.set(id, record);
    }
  }

  /**
   * The desktop that published the table went away. Answering goes through
   * it, so a push presence still holds is forgotten and judged again when a
   * desktop lists the request once more (it was never delivered). Sent ones
   * stay: they are retracted when a table no longer lists them.
   */
  forgetParked(): void {
    for (const [id, record] of [...this.pushed]) {
      if (record.state !== 'parked') continue;
      this.deps.forget(BROWSER_HELP_PARK_PREFIX + id);
      this.pushed.delete(id);
      this.handled.delete(id);
    }
  }

  /** Is this park-queue key one of ours? */
  owns(key: string): boolean {
    return key.startsWith(BROWSER_HELP_PARK_PREFIX);
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
