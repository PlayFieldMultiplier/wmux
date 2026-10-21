// #2398 — a suspended session a pane holds without promoting it (the pane is
// hidden, so its reconnect asked not to promote) is still in use. The
// suspended TTL (StateWriter.load) prunes a suspended record once nothing has
// renewed it for the TTL, and before #2398 the boot promote of every pane
// renewed it. Now a session whose pane nobody opens is held, not promoted:
// without this it would be pruned after the TTL, and its pane would lose its
// WSL target, cwd, saved buffer and resume binding. A hold stamps `heldAt`,
// which the TTL counts as use; a session whose pane is gone is never held
// again and still ages out.

import type { DaemonSession } from './types';

/** A hold renews the stamp at most this often: every reconnect of a hidden pane holds it. */
export const HOLD_RESTAMP_MS = 60 * 60 * 1000;

/**
 * Stamp `heldAt` on the suspended record `id` names: its pending-recovery
 * entry, or the disk-only record recovery left (both are what the next save
 * writes). Returns whether anything changed (a save is due).
 */
export function stampHeld(
  record: DaemonSession | undefined,
  nowMs: number,
): boolean {
  if (!record || record.state !== 'suspended') return false;
  const last = Date.parse(record.heldAt ?? '');
  if (!Number.isNaN(last) && nowMs - last < HOLD_RESTAMP_MS) return false;
  record.heldAt = new Date(nowMs).toISOString();
  return true;
}

/** The time the suspended TTL measures from: its last activity, or its last hold if later. */
export function suspendedClockMs(record: Pick<DaemonSession, 'lastActivity' | 'heldAt'>): number {
  const activity = new Date(record.lastActivity).getTime();
  const held = Date.parse(record.heldAt ?? '');
  return Number.isNaN(held) ? activity : Math.max(activity, held);
}
