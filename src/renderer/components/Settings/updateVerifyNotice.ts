/**
 * The Settings › Updates line that says a published update failed
 * verification. Pure so it is testable without the panel.
 *
 * Versions arrive in two spellings: getNotice and the verify-failed event
 * carry the manifest's (`3.5.0`), UPDATE_AVAILABLE carries the feed's tag
 * (`v3.5.0`). Compared raw, every poll's `available` for the SAME release
 * looked like a different one and cleared the line, which then came back
 * with the next verify-failed event.
 */
import { normalizeVersion } from '../../../shared/updateVersion';

/** The line's version after an UPDATE_AVAILABLE event. */
export function verifyFailedAfterAvailable(
  prev: string | null,
  data: { status: string; releaseName?: string },
): string | null {
  if (!prev) return prev;
  // This release verified after all.
  if (data.status === 'downloaded') return null;
  // Another release is on offer; the line no longer describes it.
  if (data.releaseName && normalizeVersion(data.releaseName) !== normalizeVersion(prev)) return null;
  return prev;
}

/** The version as the line shows it. */
export function verifyFailedDisplayVersion(version: string): string {
  return normalizeVersion(version);
}

/**
 * The line's version after the mount-time getNotice reply.
 *
 * The reply is a snapshot taken when the request went out; a live updater
 * event that arrived while it was in flight is fresher. `requestedAt` is the
 * live-event count when the request was sent, `eventsNow` the count when the
 * reply lands: any event in between wins, and the reply leaves the line as
 * the events set it. Without that, an `available` for a newer release could
 * clear the line and the late reply bring back a failure for an update that
 * is fine.
 */
export function verifyFailedAfterNotice(
  prev: string | null,
  replyVersion: string | null,
  requestedAt: number,
  eventsNow: number,
): string | null {
  if (eventsNow !== requestedAt) return prev;
  return prev ?? (replyVersion ? verifyFailedDisplayVersion(replyVersion) : null);
}
