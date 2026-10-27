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

import type { HelpRequests, PendingHelpRequest } from '../browser-session/HelpRequests';
import {
  PHONE_BROWSER_HELP_DECIDE_COMMAND,
  browserHelpOrigin,
  isBrowserHelpId,
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
  if (!isBrowserHelpId(requestId) || !isBrowserHelpId(workspaceId)) return { error: 'browser-help-not-found' };
  if (outcome !== 'continued' && outcome !== 'cancelled') return { error: 'browser-help-not-found' };
  const target = requests();
  if (!target) return { error: 'browser-help-disabled' };
  const result = await target.resolveFromPhone(workspaceId, requestId, outcome);
  if (result.ok) return { state: result.state };
  return { error: result.reason === 'closed' ? 'browser-help-closed' : 'browser-help-not-found' };
}

/** What main can read about one request's tab, without starting a browser. */
export interface BrowserHelpTabDeps {
  /** The browser backend setting ('builtin' | 'external' | 'chrome'). */
  backend(): string;
  /** The embedded browser pane `surfaceId` when this workspace owns it, else null. */
  builtinUrl(surfaceId: string, workspaceId: string): string | null;
  /** Whether the workspace's Chrome is the user's own (Live Chrome). */
  isLiveChrome(workspaceId: string): boolean;
  /** The tabs the workspace's dedicated Chrome recorded for it; [] while that Chrome is not running. */
  chromeTabs(workspaceId: string): Promise<Array<{ surfaceId: string; targetId: string; workspaceId?: string; url: string }>>;
}

/** One request as the phone row: the store's fields plus the tab, read now. */
export async function browserHelpRow(request: PendingHelpRequest, deps: BrowserHelpTabDeps): Promise<PhoneBrowserHelpRow> {
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
  const builtin = surfaceId !== undefined ? deps.builtinUrl(surfaceId, request.workspaceId) : null;
  if (builtin !== null) {
    const origin = browserHelpOrigin(builtin);
    return { ...base, backend: 'builtin', previewable: true, ...(origin ? { origin } : {}) };
  }
  if (deps.backend() !== 'chrome') return { ...base, backend: 'builtin', previewable: false };
  // The user's own Chrome: never read, never previewable.
  if (deps.isLiveChrome(request.workspaceId)) return { ...base, backend: 'live', previewable: false };
  let origin: string | undefined;
  if (surfaceId !== undefined) {
    try {
      const tab = (await deps.chromeTabs(request.workspaceId)).find(
        (t) => (t.surfaceId === surfaceId || t.targetId === surfaceId) && t.workspaceId === request.workspaceId,
      );
      origin = tab ? browserHelpOrigin(tab.url) : undefined;
    } catch {
      origin = undefined;
    }
  }
  // The phone's preview does not drive a Chrome tab yet.
  return { ...base, backend: 'chrome', previewable: false, ...(origin ? { origin } : {}) };
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
      const rows = await Promise.all(pending.map((r) => browserHelpRow(r, deps.tabs)));
      if (mine !== latest) return undefined;
      return deps.push(rows);
    },
  });
}
