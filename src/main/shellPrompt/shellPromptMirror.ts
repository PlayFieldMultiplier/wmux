// Main's copy of the shell prompts the daemon shows (daemon/shellPrompt). The
// daemon sends a prompt only when it changes, so this copy is what a renderer
// that loads later, or a reconnect after a missed clear, is brought back to:
// the metadata poll carries it on every pane's payload (so a renderer reload
// gets it back), and each (re)connect replaces it with the daemon's list.

import type { ShellPromptSignal } from '../../shared/shellPrompt';

const prompts = new Map<string, ShellPromptSignal>();

/** One pane's prompt as an event reported it; null clears. */
export function noteShellPrompt(ptyId: string, prompt: ShellPromptSignal | null): void {
  if (prompt) prompts.set(ptyId, prompt);
  else prompts.delete(ptyId);
}

/** The pane's current prompt, or null. */
export function shellPromptOf(ptyId: string): ShellPromptSignal | null {
  return prompts.get(ptyId) ?? null;
}

/**
 * Replace the copy with the daemon's list. Returns what changed, for the
 * renderer: a null for every pane whose prompt is gone (its clear was missed),
 * and the prompt for every pane that has one now.
 */
export function replaceShellPrompts(list: ReadonlyArray<{ sessionId: string; prompt: ShellPromptSignal }>): Array<{ ptyId: string; prompt: ShellPromptSignal | null }> {
  const next = new Map(list.map((item) => [item.sessionId, item.prompt] as const));
  const changes: Array<{ ptyId: string; prompt: ShellPromptSignal | null }> = [];
  for (const ptyId of prompts.keys()) if (!next.has(ptyId)) changes.push({ ptyId, prompt: null });
  for (const [ptyId, prompt] of next) changes.push({ ptyId, prompt });
  prompts.clear();
  for (const [ptyId, prompt] of next) prompts.set(ptyId, prompt);
  return changes;
}

/**
 * On each (re)connect: replace the copy with the daemon's list and send the
 * renderer every change. The daemon sends a prompt only when it changes, so
 * without this a prompt already waiting reads Idle and a clear missed while
 * disconnected leaves Needs you behind. A daemon that predates the list
 * (null) keeps what main had.
 */
export async function resyncShellPromptsAtConnect(
  list: () => Promise<ReadonlyArray<{ sessionId: string; prompt: ShellPromptSignal }> | null>,
  send: (ptyId: string, prompt: ShellPromptSignal | null) => void,
): Promise<void> {
  const current = await list();
  if (!current) return;
  for (const change of replaceShellPrompts(current)) send(change.ptyId, change.prompt);
}

/** Test seam. */
export function resetShellPromptMirrorForTests(): void {
  prompts.clear();
}
