/**
 * The published update whose installer failed hash verification, kept in
 * userData so the updater does not fetch the same ~150 MB again every 30
 * minutes (and after every restart) only to fail the same way. The record is
 * the (version, sha256) the manifest published; a manifest with anything else
 * is a different artifact and is downloaded as usual.
 *
 * Its own module, not inline fs calls in AutoUpdater: the updater's suites
 * mock `node:fs` with only the stream functions the download path uses, and
 * mock this module instead.
 */
import * as fs from 'fs';
import * as path from 'path';

export const VERIFY_FAILURE_FILE = 'update-verify-failed.json';

export interface VerifyFailure {
  version: string;
  sha256: string;
}

export function verifyFailurePath(userDataDir: string): string {
  return path.join(userDataDir, VERIFY_FAILURE_FILE);
}

/** Null when absent, unreadable or malformed: no record means "download as usual". */
export function readVerifyFailure(filePath: string): VerifyFailure | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (typeof raw.version !== 'string' || typeof raw.sha256 !== 'string') return null;
    if (!/^[a-f0-9]{64}$/i.test(raw.sha256)) return null;
    return { version: raw.version, sha256: raw.sha256 };
  } catch {
    return null;
  }
}

/** Best-effort: a record that cannot be written leaves the in-memory one. */
export function writeVerifyFailure(filePath: string, record: VerifyFailure): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf-8');
  } catch (err) {
    console.warn('[AutoUpdater] could not persist the failed-verification record:', err);
  }
}

export function clearVerifyFailure(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* absent already, or locked — a stale record is cleared on the next check */
  }
}
