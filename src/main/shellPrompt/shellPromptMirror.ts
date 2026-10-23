// Main's copy of the shell prompts the daemon shows (daemon/shellPrompt). The
// daemon sends a prompt only when it changes, so this copy is what a renderer
// that loads later, or a reconnect after a missed clear, is brought back to:
// the metadata poll carries it on every pane's payload (so a renderer reload
// gets it back), and each (re)connect replaces it with the daemon's list.
//
// Events and the list can arrive out of the order they happened in: the list's
// answer and an event can share one pipe chunk, and the event is applied at
// once while the answer waits on a promise. So every entry keeps the version
// that set it, and a change or a list entry applies only when it is newer. A
// clear is kept as an entry too (prompt null), so an older list cannot undo it.

import type { ShellPromptChange, ShellPromptList, ShellPromptSignal, ShellPromptVersion } from '../../shared/shellPrompt';

interface Entry extends ShellPromptVersion {
  prompt: ShellPromptSignal | null;
}

const entries = new Map<string, Entry>();

/**
 * Whether `version` comes after `entry`. Another epoch is a daemon that
 * started since: everything it says is newer than what the old one said.
 */
const isNewer = (entry: Entry | undefined, version: ShellPromptVersion): boolean =>
  !entry || entry.epoch !== version.epoch || version.seq > entry.seq;

/** One pane's prompt as an event reported it; null clears. False when it is older than what main has. */
export function noteShellPrompt(ptyId: string, change: ShellPromptChange): boolean {
  if (!isNewer(entries.get(ptyId), change)) return false;
  entries.set(ptyId, { epoch: change.epoch, seq: change.seq, prompt: change.prompt });
  return true;
}

/** The pane's current prompt, or null. */
export function shellPromptOf(ptyId: string): ShellPromptSignal | null {
  return entries.get(ptyId)?.prompt ?? null;
}

/**
 * Bring the copy up to the daemon's list. Returns what changed, for the
 * renderer: a null for every pane whose prompt is gone as of the list (its
 * clear was missed), and the prompt for every list entry newer than the copy.
 * Anything the copy holds that is newer than the list (an event that overtook
 * it) stays.
 */
export function replaceShellPrompts(list: ShellPromptList): Array<{ ptyId: string; prompt: ShellPromptSignal | null }> {
  const changes: Array<{ ptyId: string; prompt: ShellPromptSignal | null }> = [];
  const listed = new Set(list.prompts.map((item) => item.sessionId));
  for (const [ptyId, entry] of entries) {
    // Newer than the list: an event that overtook it.
    if (listed.has(ptyId) || (entry.epoch === list.epoch && entry.seq > list.seq)) continue;
    // Not on a list taken at or after it: nothing is shown there now.
    if (entry.prompt) changes.push({ ptyId, prompt: null });
    entries.delete(ptyId);
  }
  for (const item of list.prompts) {
    const version = { epoch: list.epoch, seq: item.seq };
    if (!isNewer(entries.get(item.sessionId), version)) continue;
    entries.set(item.sessionId, { ...version, prompt: item.prompt });
    changes.push({ ptyId: item.sessionId, prompt: item.prompt });
  }
  return changes;
}

/**
 * On each (re)connect: bring the copy up to the daemon's list and send the
 * renderer every change. The daemon sends a prompt only when it changes, so
 * without this a prompt already waiting reads Idle and a clear missed while
 * disconnected leaves Needs you behind. A daemon that predates the list
 * (null) keeps what main had.
 */
export async function resyncShellPromptsAtConnect(
  list: () => Promise<ShellPromptList | null>,
  send: (ptyId: string, prompt: ShellPromptSignal | null) => void,
): Promise<void> {
  const current = await list();
  if (!current) return;
  for (const change of replaceShellPrompts(current)) send(change.ptyId, change.prompt);
}

/** Test seam. */
export function resetShellPromptMirrorForTests(): void {
  entries.clear();
}
