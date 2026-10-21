/**
 * #1525 — marker reasons the install waiter writes that the renderer needs to
 * recognize, shared so the writer (installTeardown.ts, main) and the reader
 * (AppLayout's refused-install notice, renderer) cannot drift apart.
 *
 * Matching marker TEXT is normally unsafe (see takeRefusedInstall in
 * AutoUpdater.ts): the marker is written by the pre-upgrade build's waiter and
 * read by whatever build boots next. For this reason that concern does not
 * apply — a blocked installer never ran, so the build that boots next is the
 * same build that generated the waiter. A reason the reader does not
 * recognize still falls back to the generic refused-install notice.
 */

/** Stable prefix the renderer matches on. */
export const INSTALL_BLOCKED_BY_WINDOWS_PREFIX = 'install-aborted: Windows blocked the installer';

/**
 * Written when Start-Process fails with ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION
 * (4551 — Smart App Control / App Control for Business) or
 * ERROR_ACCESS_DISABLED_BY_POLICY (1260 — Software Restriction / AppLocker).
 * Single line, no apostrophes: it is embedded in the generated PowerShell.
 */
export const INSTALL_BLOCKED_BY_WINDOWS_REASON =
  `${INSTALL_BLOCKED_BY_WINDOWS_PREFIX} (Smart App Control or an application control policy). ` +
  'wmux was left unchanged. Try again in a day or two, or install from the releases page once Windows allows it.';

export function isInstallBlockedByWindowsReason(reason: string): boolean {
  return reason.trim().startsWith(INSTALL_BLOCKED_BY_WINDOWS_PREFIX);
}

/**
 * Written when the installer's SHA-256, taken immediately before it would be
 * started, no longer matches the digest the update was verified under. The
 * installer is not run (waiter exit 7). Single line, no apostrophes: it is
 * embedded in the generated PowerShell. The same build that wrote the waiter
 * reads it back (the installer never ran), so matching on it is safe.
 */
export const INSTALL_SETUP_CHANGED_REASON =
  'install-aborted: the installer changed after it was verified, so it was not run';

/**
 * Written when the installer could not be opened or read to hash it right
 * before it would be started (waiter exit 8): a sharing violation, a file
 * held or removed by another program. Not a statement about its bytes.
 */
export const INSTALL_SETUP_UNREADABLE_REASON =
  'install-aborted: the installer could not be read to verify it, so it was not run';

/** Which refused-install notice a marker reason gets; null for the generic one. */
export type RefusedInstallKind = 'blocked-by-windows' | 'setup-changed' | 'setup-unreadable';

export function refusedInstallKind(reason: string): RefusedInstallKind | null {
  const trimmed = reason.trim();
  if (isInstallBlockedByWindowsReason(trimmed)) return 'blocked-by-windows';
  if (trimmed.startsWith(INSTALL_SETUP_CHANGED_REASON)) return 'setup-changed';
  if (trimmed.startsWith(INSTALL_SETUP_UNREADABLE_REASON)) return 'setup-unreadable';
  return null;
}
