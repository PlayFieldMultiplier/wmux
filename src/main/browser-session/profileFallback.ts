// What a Chrome automation call's profile says about its bindings. A call that
// lands in 'default' only because nothing is bound uses the shared profile
// every unbound workspace shares, not one signed in for this work: a run says
// so on its record, and an unbound workspace is told once, with the last-used
// profile offered (never applied). A call in a named profile records it as
// the last used.
import { AUTOMATION_PTY_PREFIX } from '../../shared/automation';
import { DEFAULT_CHROME_PROFILE, LIVE_CHROME_PROFILE, type ChromeProfileStore } from './ChromeProfileStore';

export interface ChromeProfileUse {
  profile: string;
  workspaceId?: string;
  /** The calling pane, when the call resolved through a pane binding. */
  paneId?: string;
  callerPtyId?: string;
}

export interface ChromeProfileUseDeps {
  store: Pick<ChromeProfileStore, 'fellBackToDefault' | 'noteUsed' | 'suggestedProfile'>;
  /** Mark the live run behind this run PTY. */
  noteRun: (ptyId: string) => void;
  /** Tell the renderer this workspace's call used the shared default profile. */
  tellWorkspace: (workspaceId: string, suggested: string | undefined) => void;
}

/** One handler per app session: each run and each workspace hears it once. */
export function createChromeProfileUseHandler(deps: ChromeProfileUseDeps): (use: ChromeProfileUse) => void {
  const runsNoted = new Set<string>();
  const workspacesTold = new Set<string>();
  return (use) => {
    if (use.profile !== DEFAULT_CHROME_PROFILE || !deps.store.fellBackToDefault(use.workspaceId, use.paneId)) {
      if (use.profile !== DEFAULT_CHROME_PROFILE && use.profile !== LIVE_CHROME_PROFILE) {
        void deps.store.noteUsed(use.profile).catch(() => undefined);
      }
      return;
    }
    const ptyId = use.callerPtyId;
    if (ptyId?.startsWith(AUTOMATION_PTY_PREFIX) && !runsNoted.has(ptyId)) {
      runsNoted.add(ptyId);
      deps.noteRun(ptyId);
    }
    if (use.workspaceId && !workspacesTold.has(use.workspaceId)) {
      workspacesTold.add(use.workspaceId);
      deps.tellWorkspace(use.workspaceId, deps.store.suggestedProfile());
    }
  };
}

let listener: ((use: ChromeProfileUse) => void) | null = null;

/** Wired once by index.ts; null in tests and older wirings. */
export function setChromeProfileUseListener(next: ((use: ChromeProfileUse) => void) | null): void {
  listener = next;
}

/** Best effort: a failing listener never fails the browser call. */
export function noteChromeProfileUse(use: ChromeProfileUse): void {
  try {
    listener?.(use);
  } catch {
    /* the call goes on regardless */
  }
}
