import { useStore } from '../stores';
import { findLeaf } from '../../shared/paneUtils';
import { t } from '../i18n';
import { terminalRegistry } from '../hooks/useTerminal';
import { getDictationState, stopDictation, toggleDictation } from '../dictation/dictation';
import { deliverChatInsert } from '../components/Chat/chatAttachments';
import { pastePtyChunked, type TerminalModesLike } from './clipboardChunk';

/**
 * "Dictate into this pane" (shortcut and palette): the focused terminal pane
 * takes the transcribed text as a bracketed paste, never with an Enter. A pane
 * in Chat view takes it in its composer instead, as the mention picker does.
 */

/** Dictation's key for a pane (dictation.ts `target`). */
export function paneDictationTarget(ptyId: string): string {
  return `pane:${ptyId}`;
}

/**
 * The text as it goes on the wire. Trailing whitespace is dropped so a final
 * newline can never act as Enter. Without bracketed paste mode every line
 * break would be an Enter, so the lines are joined with spaces; inside a
 * bracketed paste they stay (pastePtyChunked keeps them in the body).
 */
export function paneDictationText(text: string, bracketed: boolean): string {
  const body = text.replace(/\s+$/, '');
  if (bracketed) return body;
  return body.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean).join(' ');
}

/** Write dictated text into a pane's PTY through the terminal's paste path. */
export function writeDictationToPty(ptyId: string, text: string, modes: TerminalModesLike | null): Promise<void> {
  const body = paneDictationText(text, !!modes?.bracketedPasteMode);
  return pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), body, modes);
}

function deliverToPane(ptyId: string, chat: boolean, text: string): void {
  const { pushToast } = useStore.getState();
  if (chat) {
    if (!deliverChatInsert(ptyId, text)) pushToast({ level: 'warn', message: t('dictation.notInserted') });
    return;
  }
  const term = terminalRegistry.get(ptyId);
  if (!term) {
    pushToast({ level: 'warn', message: t('dictation.paneGone') });
    return;
  }
  const modes = (term as unknown as { modes?: TerminalModesLike }).modes;
  void writeDictationToPty(ptyId, text, modes ?? null).catch((err) => {
    console.error('[wmux:dictation] paste failed:', err);
    useStore.getState().pushToast({ level: 'warn', message: t('dictation.paneGone') });
  });
}

/** Start dictating into the focused pane, or stop and write the text when a
 *  pane is already recording (the one it started in, wherever focus is now). */
export function dictateIntoActivePane(): void {
  const running = getDictationState();
  if (running.phase === 'recording' && running.target?.startsWith('pane:')) {
    void stopDictation();
    return;
  }
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const leaf = ws ? findLeaf(ws.rootPane, ws.activePaneId) : null;
  const surface = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  const ptyId = surface && (surface.surfaceType ?? 'terminal') === 'terminal' ? surface.ptyId : undefined;
  const chat = !!state.chatViewEnabled && surface?.viewMode === 'chat';
  if (!ptyId || (!chat && !terminalRegistry.has(ptyId))) {
    state.pushToast({ level: 'info', message: t('dictation.noPane') });
    return;
  }
  void toggleDictation(paneDictationTarget(ptyId), (text) => deliverToPane(ptyId, chat, text));
}
