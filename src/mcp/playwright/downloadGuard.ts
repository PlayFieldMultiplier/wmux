// Unprotected panes: downloads that no download tool asked for.
//
// Kept apart from tools/file.ts so PlaywrightEngine can arm it when it hands
// out a page without importing the tool module (which imports the engine).
import type { Download, Page } from 'playwright-core';

interface DownloadClaim {
  taken: boolean;
}
const downloadClaims = new WeakMap<object, DownloadClaim[]>();

/**
 * Unprotected pane: a download that no download tool asked for (a click, a
 * key press or a navigation that happened to start one) is cancelled and its
 * file deleted, so the only downloads that reach an agent are the ones the
 * operator was asked about. A download tool claims the next download before
 * it triggers or awaits one; each claim lets exactly one download through,
 * and every other one is cancelled.
 *
 * Armed per page and idempotent. Playwright calls the `download` listeners in
 * the order they were added, so a claim registered before the tool's own
 * waitForEvent is always seen by this guard first.
 */
export function guardUnclaimedDownloads(page: Page): void {
  const target = page as unknown as { on?: (event: 'download', listener: (download: Download) => void) => unknown };
  if (downloadClaims.has(page) || typeof target.on !== 'function') return;
  const claims: DownloadClaim[] = [];
  downloadClaims.set(page, claims);
  target.on('download', (download) => {
    const claim = claims.shift();
    if (claim) {
      claim.taken = true;
      return;
    }
    let host = '';
    try {
      host = new URL(download.url()).host;
    } catch {
      // No host to name.
    }
    console.warn(`[browser download] cancelled a download no download tool asked for (${host || 'unknown host'})`);
    void download.cancel().catch(() => undefined).then(() => download.delete().catch(() => undefined));
  });
}

/**
 * Claim the next download of a guarded page for a download tool. The returned
 * release withdraws the claim when no download arrived; it is a no-op once the
 * download was taken, and on a page that is not guarded.
 */
export function claimNextDownload(page: Page): () => void {
  const claims = downloadClaims.get(page);
  if (!claims) return () => undefined;
  const claim: DownloadClaim = { taken: false };
  claims.push(claim);
  return () => {
    if (claim.taken) return;
    const at = claims.indexOf(claim);
    if (at >= 0) claims.splice(at, 1);
  };
}
