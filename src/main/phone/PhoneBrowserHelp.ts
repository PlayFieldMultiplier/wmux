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
  type BrowserHelpTableRow,
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
): Promise<BrowserHelpTableRow> {
  const surfaceId = request.surfaceId !== undefined && isBrowserHelpId(request.surfaceId) ? request.surfaceId : undefined;
  const requesterPtyId = request.requesterPtyId !== undefined && isBrowserHelpId(request.requesterPtyId) ? request.requesterPtyId : undefined;
  const base = {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    ...(surfaceId !== undefined ? { surfaceId } : {}),
    ...(requesterPtyId !== undefined ? { requesterPtyId } : {}),
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
  const backend = guarded(() => deps.backend(), 'chrome');
  if (backend === 'builtin') return { ...base, backend: 'builtin', previewable: false };
  // The OS browser (or a setting not known here) is the user's own: say live.
  if (backend !== 'chrome') return { ...base, backend: 'live', previewable: false };
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
  // The phone's preview drives this tab when it is the workspace's own
  // dedicated-profile tab under the id the request names (PhoneBrowserChrome).
  const previewable = tab !== undefined && tab.surfaceId === surfaceId;
  return { ...base, backend: 'chrome', previewable, ...(origin ? { origin } : {}) };
}

/**
 * How long a tab-list read may hold a publication. A Chrome that stopped
 * answering (suspended, wedged) must not hold the table: past this its tabs
 * read as unknown (no origin) and the table goes out.
 */
export const BROWSER_HELP_TAB_READ_MS = 2_000;
/** How long a finished tab list is reused by later publications. */
export const BROWSER_HELP_TAB_CACHE_MS = 1_000;
/**
 * A read still out after this is given up on and a new one may start. The
 * list fetch cannot be aborted, so this bounds a wedged Chrome to one
 * outstanding read per workspace per this long.
 */
export const BROWSER_HELP_TAB_STALE_MS = 30_000;

/** Reads a workspace's Chrome tabs for the table. */
export type TabListReader = (workspaceId: string) => Promise<ChromeTab[]>;

/**
 * One tab-list read per workspace at a time, shared by every publication:
 * a newer change reuses the read already out (or one that finished in the
 * last BROWSER_HELP_TAB_CACHE_MS) instead of starting another, and waits for
 * it only until BROWSER_HELP_TAB_READ_MS after it started. So a stalled
 * Chrome costs one wait, once; every later publication goes out at once
 * without that tab's origin, and no fetches pile up behind it.
 */
export function createTabListReader(
  read: (workspaceId: string) => Promise<ChromeTab[]>,
  opts: { budgetMs?: number; cacheMs?: number; staleMs?: number; now?: () => number } = {},
): TabListReader {
  const budgetMs = opts.budgetMs ?? BROWSER_HELP_TAB_READ_MS;
  const cacheMs = opts.cacheMs ?? BROWSER_HELP_TAB_CACHE_MS;
  const staleMs = opts.staleMs ?? BROWSER_HELP_TAB_STALE_MS;
  const now = opts.now ?? Date.now;
  interface Entry { startedAt: number; settledAt?: number; value?: ChromeTab[]; done: Promise<ChromeTab[]> }
  const entries = new Map<string, Entry>();
  return (workspaceId) => {
    const at = now();
    let entry = entries.get(workspaceId);
    const expired = entry && (entry.settledAt !== undefined ? at - entry.settledAt > cacheMs : at - entry.startedAt > staleMs);
    if (!entry || expired) {
      const fresh: Entry = { startedAt: at, done: Promise.resolve([]) };
      fresh.done = Promise.resolve()
        .then(() => read(workspaceId))
        .catch(() => [] as ChromeTab[])
        .then((value) => {
          fresh.value = value;
          fresh.settledAt = now();
          return value;
        });
      entries.set(workspaceId, fresh);
      entry = fresh;
    }
    if (entry.value !== undefined) return Promise.resolve(entry.value);
    const left = entry.startedAt + budgetMs - at;
    if (left <= 0) return Promise.resolve([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<ChromeTab[]>((resolve) => {
      timer = setTimeout(() => resolve([]), left);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([entry.done, giveUp]).finally(() => clearTimeout(timer));
  };
}

/** Every request's row, oldest first, capped and checked. */
export async function browserHelpRows(
  pending: readonly PendingHelpRequest[],
  deps: BrowserHelpTabDeps,
  tabsOf: TabListReader = createTabListReader((ws) => deps.chromeTabs(ws)),
): Promise<BrowserHelpTableRow[]> {
  const rows = await Promise.all(pending.map((r) => browserHelpRow(r, deps, tabsOf)));
  // A row the daemon would refuse would cost the whole table: drop it here.
  return rows.filter((row) => parseBrowserHelpRow(row) !== null).slice(0, BROWSER_HELP_MAX_ROWS);
}

/**
 * The table feed: coalesced on change and at once on `publishNow`. A request
 * leaves the table when the store settles it (its own deadline timer
 * included); the daemon drops a row past its deadline on its own. Tab lists
 * come from one shared reader (createTabListReader). Only the newest
 * publication is sent: an older one that finishes its reads later is dropped
 * rather than overwriting the newer table.
 */
export function createBrowserHelpFeed(deps: {
  pending: () => PendingHelpRequest[] | null;
  tabs: BrowserHelpTabDeps;
  push: (rows: BrowserHelpTableRow[]) => Promise<unknown>;
  /** Test seam; production shares one reader across every publication. */
  tabReader?: TabListReader;
}): PushTableFeed {
  let latest = 0;
  const tabsOf = deps.tabReader ?? createTabListReader((ws) => deps.tabs.chromeTabs(ws));
  return createPushTableFeed<PendingHelpRequest>({
    rows: deps.pending,
    push: async (pending) => {
      const mine = ++latest;
      const rows = await browserHelpRows(pending, deps.tabs, tabsOf);
      if (mine !== latest) return undefined;
      return deps.push(rows);
    },
  });
}
