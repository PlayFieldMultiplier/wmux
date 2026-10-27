/**
 * The members of `window.electronAPI` the browser build implements. Everything
 * else is denied by `createElectronApiShim`. Each entry here is a static value,
 * a subscription that never fires, or — for `pty` only — a forwarder to the
 * page's terminal bridge (webPty.ts), which reads pane streams and, when this
 * caller may type, posts input. `pty.create` / `dispose` / `promote` /
 * `resize` are not members, so they stay denied.
 */
import type { ShimImpl } from './electronApiShim';

/** The flat client: fallback for old browsers, and the token/pairing screens. */
export const CLASSIC_PATH = '/classic';

/** Where the es2022 bundle publishes the terminal bridge (webPty.ts `pty`). */
export const WEB_PTY_BRIDGE_KEY = '__wmuxWebPtyBridge';

/** Map the browser's platform hint onto the Node platform names components switch on. */
export function platformFromNavigator(nav: Pick<Navigator, 'userAgent'> & { platform?: string }): 'darwin' | 'win32' | 'linux' {
  const hint = `${nav.platform ?? ''} ${nav.userAgent}`;
  if (/Win/i.test(hint)) return 'win32';
  if (/Mac|iPhone|iPad|iPod/i.test(hint)) return 'darwin';
  return 'linux';
}

type Bridge = Record<string, (...args: unknown[]) => unknown>;

const PTY_SUBSCRIPTIONS = ['onData', 'onExit', 'onFlushComplete', 'onRestarted'] as const;
const PTY_CALLS = ['setViewerVisibility', 'write', 'list', 'reconnect', 'resync'] as const;

function notReady(): Promise<never> {
  const p = Promise.reject(new Error('terminal bridge not ready'));
  p.catch(() => undefined);
  return p;
}

/**
 * `pty.*` resolved at CALL time: this object is installed by the es2017 boot
 * script, before the bundle that owns the bridge has run.
 */
export function lateBoundPty(get: () => Bridge | undefined): Record<string, (...args: unknown[]) => unknown> {
  const out: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of PTY_SUBSCRIPTIONS) {
    out[name] = (...args) => {
      const bridge = get();
      return bridge ? bridge[name](...args) : () => undefined;
    };
  }
  for (const name of PTY_CALLS) {
    out[name] = (...args) => {
      const bridge = get();
      return bridge ? bridge[name](...args) : notReady();
    };
  }
  // The desktop types a resume line through main (pty.writeLaunch); the
  // browser has no main, so the line goes out as typed input.
  out.writeLaunch = (id, text, submit) => {
    const bridge = get();
    return bridge ? bridge.write(id, submit === true ? `${String(text)}\r` : text) : notReady();
  };
  return out;
}

export function webElectronApiImpl(
  nav: Pick<Navigator, 'userAgent' | 'language'> & { platform?: string },
  getPtyBridge: () => Bridge | undefined = () => undefined,
): ShimImpl {
  return {
    platform: platformFromNavigator(nav),
    windowsBuildNumber: null,
    systemLocale: nav.language || 'en',
    // uiSlice reads this synchronously at module load; `undefined` means "no
    // sync answer", and the store keeps its default.
    browser: { getBackendSync: () => undefined },
    // Store actions announce pane focus/creation to the desktop's EventBus
    // (events/publisher.ts). The browser has no bus and must not reach the
    // daemon from a tap, so the announcement goes nowhere.
    events: { publish: () => undefined },
    // useTerminal reattaches on a daemon (re)connect; the browser has no
    // daemon link of its own to report — its streams reconnect themselves.
    daemon: { onConnected: () => () => undefined },
    pty: lateBoundPty(getPtyBridge),
    // The daemon's OS (from /api/config), for key encodings the pane's host
    // decides; null until known. `platform` above stays the browser's, which
    // is what the keyboard in front of the user follows.
    hostPlatform: (): string | null => {
      const answer = getPtyBridge()?.hostPlatform?.();
      return typeof answer === 'string' ? answer : null;
    },
  };
}

/** The desktop clipboard IPC's cap (clipboard.handler.ts); a longer copy is not kept. */
const MAX_PENDING_COPY_CHARS = 1_000_000;
/** A refused copy waits this long for the user's next click, tap or key, then is dropped. */
export const PENDING_COPY_TTL_MS = 60_000;

/** `waiting`: a copy needs the user's next click, tap or key. `copied` / `dropped`: it no longer does. */
export type PendingCopyState = 'waiting' | 'copied' | 'dropped';

/** `keepIfRefused: false`: a refused write fails at once instead of waiting for a gesture. */
export interface WebWriteOptions { keepIfRefused?: boolean }

/**
 * `window.clipboardAPI` (the desktop preload's clipboard bridge) on the
 * browser's own clipboard. Reads and writes need a secure context and, for
 * reads, the browser's permission; anything unavailable answers empty.
 *
 * A write the browser refuses outside a user gesture (an OSC 52 copy arrives
 * over the network, after the click that caused it) is kept as one pending
 * copy and retried inside the user's next click, tap or key press, or by
 * `finishPendingCopy` from the hint's own click. Its promise settles with that
 * outcome; a newer copy or the TTL drops it.
 */
export function webClipboardApi(
  nav: Pick<Navigator, 'clipboard'> & { userActivation?: { isActive: boolean } },
  doc: Pick<Document, 'createElement' | 'execCommand' | 'body' | 'activeElement' | 'addEventListener' | 'removeEventListener'> | null = typeof document === 'undefined' ? null : document,
): Record<string, unknown> {
  const clip = nav.clipboard as Clipboard | undefined;
  // Outside a secure context there is no async clipboard; the legacy copy
  // command still works inside the key press that asked for it.
  const legacyCopy = (text: string): boolean => {
    if (!doc?.body) return false;
    // Selecting the textarea takes focus; hand it back so the key or tap in
    // progress still reaches the terminal.
    const prev = doc.activeElement as HTMLElement | null;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = doc.execCommand('copy'); } catch { ok = false; }
    area.remove();
    prev?.focus?.({ preventScroll: true });
    return ok;
  };
  const writeNow = (text: string): Promise<void> => {
    if (clip?.writeText) return clip.writeText(text).catch(() => (legacyCopy(text) ? undefined : Promise.reject(new Error('copy refused'))));
    return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('clipboard unavailable in this browser context'));
  };
  // A retry has the async clipboard or the legacy command, never both: the
  // legacy fallback, run after the async refusal has left the gesture, would
  // only take focus (and break a composition) for nothing.
  const retryWrite = (text: string): Promise<void> => {
    if (clip?.writeText) return clip.writeText(text);
    return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy refused'));
  };

  let listener: ((state: PendingCopyState) => void) | null = null;
  let pending: { text: string; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; retrying: boolean; expired: boolean; seq: number } | null = null;
  // Each writeText call's number, so a late answer to an older write cannot
  // override a newer one; `inFlight` holds the ones not answered yet.
  let writeSeq = 0;
  const inFlight = new Set<number>();
  const gestureEvents = ['keydown', 'pointerdown', 'pointerup'] as const;
  const clearPending = (outcome: 'copied' | Error): void => {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    for (const type of gestureEvents) doc?.removeEventListener(type, onGesture, true);
    if (outcome === 'copied') p.resolve();
    else p.reject(outcome);
    listener?.(outcome === 'copied' ? 'copied' : 'dropped');
  };
  const expired = () => new Error('copy expired before a gesture');
  // Must run synchronously inside the gesture that calls it.
  const retryPending = (): void => {
    const p = pending;
    if (!p || p.retrying) return;
    // A newer write is still out: its answer decides what the clipboard holds.
    for (const seq of inFlight) if (seq > p.seq) return;
    p.retrying = true;
    retryWrite(p.text).then(
      () => { p.retrying = false; if (pending === p) clearPending('copied'); },
      // Still refused: keep it for the next gesture, unless the TTL passed meanwhile.
      () => { p.retrying = false; if (pending === p && p.expired) clearPending(expired()); },
    );
  };
  // Only the events that grant user activation: a touch press grants it on
  // release, a mouse press on press. The event itself is left untouched.
  function onGesture(e: Event): void {
    const pointerType = (e as PointerEvent).pointerType;
    if (e.type === 'pointerdown' && pointerType !== 'mouse') return;
    if (e.type === 'pointerup' && pointerType === 'mouse') return;
    retryPending();
  }
  const keepPending = (text: string, err: unknown, seq: number): Promise<void> => {
    if (!doc || text.length > MAX_PENDING_COPY_CHARS || seq !== writeSeq) return Promise.reject(err);
    clearPending(new Error('copy replaced by a newer one'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = pending;
        if (!p || p.seq !== seq) return;
        // A retry in flight settles it; dropping it now could lose a copy that lands.
        if (p.retrying) { p.expired = true; return; }
        clearPending(expired());
      }, PENDING_COPY_TTL_MS);
      pending = { text, resolve, reject, timer, retrying: false, expired: false, seq };
      for (const type of gestureEvents) doc.addEventListener(type, onGesture, true);
      listener?.('waiting');
    });
  };
  // A newer copy that lands drops the pending one, and a refusal is kept only
  // while no newer write has started, so a later tap cannot put older text back.
  // A refusal inside a gesture is final (a gesture is what a retry would add).
  const writeText = (text: string, opts?: WebWriteOptions): Promise<void> => {
    const seq = ++writeSeq;
    const inGesture = nav.userActivation?.isActive === true;
    inFlight.add(seq);
    return writeNow(text).then(
      () => {
        inFlight.delete(seq);
        if (pending && pending.seq < seq) clearPending(new Error('copy replaced by a newer one'));
      },
      (err: unknown) => {
        inFlight.delete(seq);
        return inGesture || opts?.keepIfRefused === false ? Promise.reject(err) : keepPending(text, err, seq);
      },
    );
  };
  return {
    /** Web only: the pending-copy hint follows this. One listener; returns its unsubscribe. */
    onPendingCopy: (fn: (state: PendingCopyState) => void) => {
      listener = fn;
      return () => { if (listener === fn) listener = null; };
    },
    /** Web only: the hint's click. Completes the pending copy inside that click. */
    finishPendingCopy: retryPending,
    // useTerminal leaves ⌘V / Ctrl+V / Ctrl+Shift+V to the browser's paste
    // event (xterm brackets it) instead of reading the clipboard itself.
    nativePaste: true,
    writeText,
    readText: () => (clip?.readText ? clip.readText().catch(() => '') : Promise.resolve('')),
    readImage: () => Promise.resolve(null),
    hasImage: () => Promise.resolve(false),
    writeEphemeral: (text: string) => writeText(text),
    keepEphemeral: () => Promise.resolve(),
  };
}
