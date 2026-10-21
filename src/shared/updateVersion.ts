/**
 * One spelling for a release version wherever two sources meet. The update
 * feed names releases by tag (`v3.5.0`), the manifest by version (`3.5.0`);
 * compare and display through this so the two never read as different.
 */

/** Strip a leading "v" so "v2.14.0" and "2.14.0" compare equal. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}
