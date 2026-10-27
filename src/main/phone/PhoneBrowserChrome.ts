// The phone preview's driver for a tab of a DEDICATED wmux Chrome profile
// (PhoneBrowser.ts holds the checks every tab gets). It speaks CDP over a page
// session the profile's launcher attaches on its own browser socket
// (ChromeLauncher.pageSession), so it never opens a second connection and
// never launches Chrome. Live Chrome has no page sessions and no tabs here.
//
// What differs from a builtin pane:
//  - geometry comes from Page.getLayoutMetrics, and the capture is clipped to
//    that visual viewport, so a normalized point means the same pixel;
//  - a whole capture has its own budget (HIDDEN_MS): Chrome may stop painting
//    a background tab, and a capture that does not finish says so
//    (`browser-tab-hidden`) instead of running into the bridge's timeout;
//  - nothing brings the tab forward except the phone's explicit `focus`;
//    typing uses focus emulation instead;
//  - viewport emulation does not exist here (`browser-action-unsupported`).
// Typed text is sent once, to Chrome, and is never echoed or put in an error.

import { phoneBrowserGeometry } from './PhoneBrowserGeometry';
import type { PhoneBrowserDriver } from './PhoneBrowser';
import { ChromePageSessionError, type ChromeBackendClient, type ChromePageSession, type ChromeTargetInfo } from '../browser-session/ChromeLauncher';
import { LIVE_CHROME_PROFILE } from '../browser-session/ChromeProfileStore';
import type { ChromePaneBindings } from '../../shared/chromePaneBinding';
import { parseKeyPress } from '../pipe/handlers/cdpKeys';
import { PhoneBrowserError } from '../../shared/phoneBrowserPreview';

/** How long a whole Chrome capture may take before the tab reads as hidden. */
export const PHONE_CHROME_CAPTURE_MS = 5_000;

export interface PhoneChromeTab { surfaceId: string; url: string; title: string }

/** Main's dedicated Chrome profiles, as the phone preview may see them. */
export interface PhoneChromeDeps {
  /**
   * The tabs wmux opened whose recorded workspace is exactly `workspaceId`,
   * across the profiles that workspace and its panes use. Never Live Chrome,
   * never launches Chrome: [] while no Chrome is running.
   */
  tabs(workspaceId: string): Promise<PhoneChromeTab[]>;
  /** A page session on one of those tabs; throws ChromePageSessionError. */
  session(surfaceId: string, workspaceId: string): Promise<ChromePageSession>;
  /** Bring one of those tabs, and its window, to the front. */
  focus(surfaceId: string, workspaceId: string): Promise<boolean>;
  /** Whether `open` would land in a dedicated profile (never Live Chrome). */
  canOpen(workspaceId: string): boolean;
  /** The desktop's navigation policy for one URL; throws when it refuses. */
  validateNavigation(url: string): Promise<void>;
  /** Test seam for PHONE_CHROME_CAPTURE_MS. */
  captureMs?: number;
}

/** Surfaces with a phone input in flight: one at a time per tab. */
const active = new Set<string>();

function coded(err: unknown): unknown {
  if (err instanceof ChromePageSessionError) {
    return new PhoneBrowserError(err.reason === 'gone' ? 'browser-tab-gone' : 'browser-backend-unavailable');
  }
  return err;
}

interface Viewport { clientWidth: number; clientHeight: number; pageX: number; pageY: number; scale: number }

function viewportOf(metrics: unknown): Viewport {
  const m = metrics as { cssVisualViewport?: Partial<Viewport>; visualViewport?: Partial<Viewport> } | null;
  const vp = m?.cssVisualViewport ?? m?.visualViewport;
  const value = phoneBrowserGeometry({ id: 'phone-chrome', ok: true, result: { value: {
    width: vp?.clientWidth, height: vp?.clientHeight, scrollX: vp?.pageX, scrollY: vp?.pageY, scale: 1,
  } } });
  return { clientWidth: value.width, clientHeight: value.height, pageX: value.scrollX, pageY: value.scrollY, scale: typeof vp?.scale === 'number' ? vp.scale : NaN };
}

export function chromeDriver(surfaceId: string, workspaceId: string, deps: PhoneChromeDeps): PhoneBrowserDriver {
  const tab = async () => (await deps.tabs(workspaceId)).find(t => t.surfaceId === surfaceId) ?? null;
  const call = async (method: string, params?: Record<string, unknown>) => {
    try {
      const session = await deps.session(surfaceId, workspaceId);
      return await session.send(method, params);
    } catch (err) {
      throw coded(err);
    }
  };
  /** A failed write says only that it failed: never Chrome's words, which could quote the input. */
  const write = async (method: string, params: Record<string, unknown>) => {
    try {
      await call(method, params);
    } catch (err) {
      if (err instanceof PhoneBrowserError) throw err;
      throw new Error('Browser operation failed');
    }
  };
  const withFocus = async (operation: () => Promise<void>) => {
    // A background Chrome window has no focused element to type into; emulate
    // focus for this one operation instead of raising the tab.
    await write('Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await operation();
    } finally {
      await write('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    }
  };
  const viewport = async () => viewportOf(await call('Page.getLayoutMetrics'));
  return {
    backend: 'chrome',
    surfaceId,
    page: async () => {
      const found = await tab();
      return found ? { title: found.title, url: found.url } : null;
    },
    owned: async () => (await tab()) !== null,
    geometry: async () => {
      const vp = await viewport();
      // Pinch zoom moves the visual viewport off the layout one: readable, not tappable.
      if (vp.scale !== 1) throw new Error('Unsupported browser geometry');
      return { width: vp.clientWidth, height: vp.clientHeight, scrollX: vp.pageX, scrollY: vp.pageY };
    },
    shoot: async (quality, scale) => {
      const vp = await viewport();
      let shot: unknown;
      try {
        shot = await call('Page.captureScreenshot', {
          format: 'jpeg', quality,
          // Document coordinates of what is on screen, so the image is the
          // viewport the geometry describes.
          clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale },
        });
      } catch (err) {
        if (err instanceof PhoneBrowserError) throw err;
        // A listed tab that cannot produce a frame is one Chrome is not painting.
        throw new PhoneBrowserError('browser-tab-hidden');
      }
      const data = (shot as { data?: unknown } | null)?.data;
      if (typeof data !== 'string' || !data) throw new Error('Browser capture unavailable');
      return { data, mimeType: 'image/jpeg' as const };
    },
    capture: async run => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hidden = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PhoneBrowserError('browser-tab-hidden')), deps.captureMs ?? PHONE_CHROME_CAPTURE_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      const running = run();
      // The losing side of the race must never surface as an unhandled rejection.
      running.catch(() => undefined);
      try {
        return await Promise.race([running, hidden]);
      } finally {
        clearTimeout(timer);
      }
    },
    input: async operation => {
      if (active.has(surfaceId)) throw new Error('Browser input unavailable');
      active.add(surfaceId);
      try {
        await operation();
      } finally {
        active.delete(surfaceId);
      }
    },
    tap: async ({ x, y }) => {
      await write('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await write('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await write('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    scroll: async event => {
      // Move first, so Chromium hit-tests the wheel where the phone pointed.
      await write('Input.dispatchMouseEvent', { type: 'mouseMoved', x: event.x, y: event.y, button: 'none', buttons: 0 });
      await write('Input.dispatchMouseEvent', { type: 'mouseWheel', ...event });
    },
    type: text => withFocus(() => write('Input.insertText', { text })),
    key: key => withFocus(async () => {
      const { keyDown, keyUp } = parseKeyPress(key);
      await write('Input.dispatchKeyEvent', keyDown);
      await write('Input.dispatchKeyEvent', keyUp);
    }),
    navigate: async url => {
      await deps.validateNavigation(url);
      let result: unknown;
      try {
        result = await call('Page.navigate', { url });
      } catch (err) {
        if (err instanceof PhoneBrowserError) throw err;
        throw new Error('Browser operation failed');
      }
      if ((result as { errorText?: unknown } | null)?.errorText) throw new Error('Browser operation failed');
    },
    viewport: async () => { throw new PhoneBrowserError('browser-action-unsupported'); },
    focus: async () => {
      if (!(await deps.focus(surfaceId, workspaceId))) throw new Error('Browser operation failed');
    },
  };
}

/** What main's wiring hands phoneChromeTabs: the registry, read-only. */
export interface PhoneChromeRegistry {
  profileFor(workspaceId: string | undefined): string;
  peekLauncher(profile: string): ChromeBackendClient | undefined;
}

function isLive(profile: string): boolean {
  return profile.toLowerCase() === LIVE_CHROME_PROFILE;
}

/**
 * The dedicated Chrome clients a workspace's tabs may be in: its own profile
 * and every profile one of its panes is bound to. Never Live Chrome, never a
 * client with a write scope (that is Live), and never one that does not exist
 * yet: reading a tab must not start a browser.
 */
function clientsFor(workspaceId: string, registry: PhoneChromeRegistry, paneBindings: () => ChromePaneBindings): ChromeBackendClient[] {
  const profiles = new Set<string>([registry.profileFor(workspaceId)]);
  for (const binding of Object.values(paneBindings())) {
    if (binding.workspaceId === workspaceId) profiles.add(binding.profile);
  }
  const clients: ChromeBackendClient[] = [];
  for (const profile of profiles) {
    if (isLive(profile)) continue;
    const client = registry.peekLauncher(profile);
    if (client && !client.writeScope && client.pageSession && !clients.includes(client)) clients.push(client);
  }
  return clients;
}

/**
 * The workspace's dedicated-profile tabs, each with the client that holds it:
 * only tabs whose recorded workspace is exactly this one (listTargets lets a
 * tab with no workspace through). The help table (PhoneBrowserHelp) reads the
 * same list, so a row is previewable exactly when the preview can drive it.
 */
export async function phoneChromeTabs(
  workspaceId: string,
  registry: PhoneChromeRegistry,
  paneBindings: () => ChromePaneBindings,
): Promise<Array<{ tab: ChromeTargetInfo; client: ChromeBackendClient }>> {
  const out: Array<{ tab: ChromeTargetInfo; client: ChromeBackendClient }> = [];
  for (const client of clientsFor(workspaceId, registry, paneBindings)) {
    let tabs: ChromeTargetInfo[];
    try {
      tabs = await client.listTargets(workspaceId);
    } catch {
      continue;
    }
    for (const tab of tabs) if (tab.workspaceId === workspaceId) out.push({ tab, client });
  }
  return out;
}

/** main's PhoneChromeDeps over the Chrome registry. */
export function createPhoneChromeDeps(opts: {
  registry: PhoneChromeRegistry;
  paneBindings: () => ChromePaneBindings;
  validateNavigation: (url: string) => Promise<void>;
}): PhoneChromeDeps {
  const holder = async (surfaceId: string, workspaceId: string) =>
    (await phoneChromeTabs(workspaceId, opts.registry, opts.paneBindings)).find(({ tab }) => tab.surfaceId === surfaceId);
  return {
    tabs: async (workspaceId) => (await phoneChromeTabs(workspaceId, opts.registry, opts.paneBindings))
      .map(({ tab }) => ({ surfaceId: tab.surfaceId, url: tab.url, title: tab.title })),
    session: async (surfaceId, workspaceId) => {
      const found = await holder(surfaceId, workspaceId);
      if (!found?.client.pageSession) throw new ChromePageSessionError('gone', 'not a tab of this workspace');
      return found.client.pageSession(surfaceId);
    },
    focus: async (surfaceId, workspaceId) => {
      const found = await holder(surfaceId, workspaceId);
      if (!found?.client.selectSurface || !(await found.client.selectSurface(surfaceId))) return false;
      // The phone's tap is a person's explicit "show me": un-minimize too.
      const restore = (found.client as { restoreWindow?: (id: string) => Promise<void> }).restoreWindow;
      if (restore) await restore.call(found.client, surfaceId);
      return true;
    },
    canOpen: (workspaceId) => !isLive(opts.registry.profileFor(workspaceId)),
    validateNavigation: opts.validateNavigation,
  };
}
