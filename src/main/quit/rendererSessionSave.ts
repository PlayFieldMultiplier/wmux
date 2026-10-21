/**
 * Ask the renderer to save its session, bounded.
 *
 * The renderer saves on `beforeunload`, so main dispatches that event through
 * executeJavaScript. That call goes to a process that may never answer:
 * `isCrashed()` only reports a renderer Electron has already noticed is gone,
 * and a hung renderer is not crashed at all. Unbounded, a caller waits for
 * ever — before-quit never quits (#980), and the updater's install stays
 * latched "already in progress". Both callers share this one bound.
 */

/**
 * #980 — how long the renderer gets to run its beforeunload save. Short: the
 * save is a synchronous dispatch, so anything past this is a renderer that is
 * not going to answer at all.
 */
export const RENDERER_SAVE_TIMEOUT_MS = 3_000;

/** Rejects when the renderer has not answered within `timeoutMs`. */
export async function requestRendererSessionSave(
  webContents: { executeJavaScript: (code: string) => Promise<unknown> },
  timeoutMs: number = RENDERER_SAVE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      webContents.executeJavaScript(
        `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('renderer session-save timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
