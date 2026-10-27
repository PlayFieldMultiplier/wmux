// Main's half of browser help requests on the phone (shared/phoneBrowserHelp.ts):
//
//  - the table: every open request, with what the desktop can tell about its
//    tab right now (backend, previewable, origin), sent to the daemon over
//    `daemon.browserHelp.set` whenever a request opens or settles, and on
//    every daemon connect once the phone bridge is registered;
//  - the decision: `workspaces.browserHelpDecide`, which settles one request
//    through `HelpRequests.resolveFromPhone` in the workspace the daemon's
//    table names for it.
//
// Reading a tab never starts a browser: a dedicated Chrome profile is only
// asked when its launcher already exists (it lists nothing while Chrome is
// down), and Live Chrome — the user's own browser — is never asked at all.
// The store does not record which Chrome profile a request came from, so a
// workspace whose panes have their own profiles is told apart by where the
// tab is found, and a request that may be on Live Chrome is labelled `live`.

import type { HelpRequests, PendingHelpRequest } from '../browser-session/HelpRequests';
import {
  BROWSER_HELP_MAX_ROWS,
  PHONE_BROWSER_HELP_DECIDE_COMMAND,
  browserHelpOrigin,
  isBrowserHelpId,
  parseBrowserHelpRow,
  type PhoneBrowserHelpDecideReply,
  type PhoneBrowserHelpRow,
} from '../../shared/phoneBrowserHelp';
import { createPushTableFeed, type PushTableFeed } from './pushTableFeed';

type Store = Pick<HelpRequests, 'resolveFromPhone'>;

let store: Store | null = null;

/** Wired once by index.ts; null in tests and before it runs. */
export function setPhoneBrowserHelpStore(next: Store | null): void {
  store = next;
}

/** `workspaces.browserHelpDecide`; null for any other command. */
export async function handlePhoneBrowserHelpCommand(
  command: string,
  payload: Record<string, unknown>,
  requests: () => Store | null = () => store,
): Promise<PhoneBrowserHelpDecideReply | null> {
  if (command !== PHONE_BROWSER_HELP_DECIDE_COMMAND) return null;
  const { requestId, workspaceId, outcome } = payload;
  if (!isBrowserHelpId(requestId) || !isBrowserHelpId(workspaceId)) return { invalid: true };
  if (outcome !== 'continued' && outcome !== 'cancelled') return { invalid: true };
  const target = requests();
  if (!target) return { unavailable: true };
  const result = await target.resolveFromPhone(workspaceId, requestId, outcome);
  if (result.ok) return { state: result.state };
  return { error: result.reason === 'closed' ? 'browser-help-closed' : 'browser-help-not-found' };
}

type ChromeTab = { surfaceId: string; targetId: string; workspaceId?: string; url: string };

/** What main can read about one request's tab, without starting a browser. */
export interface BrowserHelpTabDeps {
  /** The browser backend setting ('builtin' | 'external' | 'chrome'). */
  backend(): string;
  /** The URL of the embedded browser pane `surfaceId` when this workspace owns it, else null. */
  builtinUrl(surfaceId: string, workspaceId: string): string | null;
  /**
   * Whether the request may be on the user's own Chrome (Live Chrome): the
   * workspace's profile is Live, or a pane of the workspace may be bound to
   * it. `tabFound` says the tab was found in the workspace's dedicated Chrome.
   */
  mayBeLiveChrome(workspaceId: string, tabFound: boolean): boolean;
  /** The tabs the workspace's dedicated Chrome recorded; [] while that Chrome is not running or the profile is Live. */
  chromeTabs(workspaceId: string): Promise<ChromeTab[]>;
}

/** Run a read, answering `fallback` when it throws: one bad lookup must not cost the whole table. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * One request as the phone row: the store's fields plus the tab, read now.
 * `tabsOf` is the workspace's dedicated Chrome tabs, shared by the rows of
 * one publication. When the browser cannot be told apart, the row says
 * `live`: never previewable, no origin read.
 */
export async function browserHelpRow(
  request: PendingHelpRequest,
  deps: BrowserHelpTabDeps,
  tabsOf: (workspaceId: string) => Promise<ChromeTab[]> = (ws) => deps.chromeTabs(ws),
): Promise<PhoneBrowserHelpRow> {
  const surfaceId = request.surfaceId !== undefined && isBrowserHelpId(request.surfaceId) ? request.surfaceId : undefined;
  const base = {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    ...(surfaceId !== undefined ? { surfaceId } : {}),
    prompt: request.prompt,
    createdAt: request.createdAt,
    deadlineAt: request.deadlineAt,
  };
  // An embedded pane this workspace owns: the phone's preview can show it.
  const builtin = surfaceId !== undefined ? guarded(() => deps.builtinUrl(surfaceId, request.workspaceId), null) : null;
  if (builtin !== null) {
    const origin = browserHelpOrigin(builtin);
    return { ...base, backend: 'builtin', previewable: true, ...(origin ? { origin } : {}) };
  }
  if (guarded(() => deps.backend(), 'chrome') !== 'chrome') return { ...base, backend: 'builtin', previewable: false };
  let tab: ChromeTab | undefined;
  if (surfaceId !== undefined) {
    try {
      tab = (await tabsOf(request.workspaceId)).find(
        (t) => (t.surfaceId === surfaceId || t.targetId === surfaceId) && t.workspaceId === request.workspaceId,
      );
    } catch {
      tab = undefined;
    }
  }
  // The user's own Chrome: never read, never previewable.
  if (guarded(() => deps.mayBeLiveChrome(request.workspaceId, tab !== undefined), true)) {
    return { ...base, backend: 'live', previewable: false };
  }
  const origin = tab ? browserHelpOrigin(tab.url) : undefined;
  // The phone's preview does not drive a Chrome tab yet.
  return { ...base, backend: 'chrome', previewable: false, ...(origin ? { origin } : {}) };
}

/** Every request's row, the workspace tab lists read once each, oldest first, capped and checked. */
export async function browserHelpRows(pending: readonly PendingHelpRequest[], deps: BrowserHelpTabDeps): Promise<PhoneBrowserHelpRow[]> {
  const lists = new Map<string, Promise<ChromeTab[]>>();
  const tabsOf = (ws: string) => {
    let list = lists.get(ws);
    if (!list) {
      list = deps.chromeTabs(ws);
      lists.set(ws, list);
    }
    return list;
  };
  const rows = await Promise.all(pending.map((r) => browserHelpRow(r, deps, tabsOf)));
  // A row the daemon would refuse would cost the whole table: drop it here.
  return rows.filter((row) => parseBrowserHelpRow(row) !== null).slice(0, BROWSER_HELP_MAX_ROWS);
}

/**
 * The table feed: coalesced on change, at once on `publishNow`, and again at
 * the earliest deadline so an expired request leaves the phone's list even
 * when its timer is late. The tab reads are async, so only the newest
 * publication is sent: an older one that finishes its reads later is dropped
 * rather than overwriting the newer table.
 */
export function createBrowserHelpFeed(deps: {
  pending: () => PendingHelpRequest[] | null;
  tabs: BrowserHelpTabDeps;
  push: (rows: PhoneBrowserHelpRow[]) => Promise<unknown>;
}): PushTableFeed {
  let latest = 0;
  return createPushTableFeed<PendingHelpRequest>({
    rows: deps.pending,
    refreshAt: (rows) => (rows.length ? Math.min(...rows.map((r) => r.deadlineAt)) : undefined),
    push: async (pending) => {
      const mine = ++latest;
      const rows = await browserHelpRows(pending, deps.tabs);
      if (mine !== latest) return undefined;
      return deps.push(rows);
    },
  });
}
