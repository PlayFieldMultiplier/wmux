// Usage-limit card → "Continue in <agent>": a held pane's work goes on in
// another installed, signed-in agent. A new tab in the same pane starts that
// agent in the pane's folder; once its prompt is up, a handoff note is pasted
// into its input and never submitted, so the owner reads it before sending.
// The held tab stays as it was.

import { useStore } from '../stores';
import { t } from '../i18n';
import { terminalRegistry } from '../hooks/useTerminal';
import { agentRow } from '../../shared/agentIdentity';
import type { AgentId } from '../../shared/agentSetup';
import type { AgentStatus } from '../../shared/types';
import { openTerminalTab } from './accountLogin';
import { pastePtyChunked } from './clipboardChunk';

/** Longest last request the handoff note quotes. */
export const HANDOFF_REQUEST_MAX = 2000;
/** How long the new agent has to show its prompt. */
export const AGENT_READY_TIMEOUT_MS = 60_000;

/** Agent states with its prompt up and waiting for input. */
const READY: readonly AgentStatus[] = ['idle', 'waiting', 'awaiting_input', 'complete'];

/** The note pasted into the new agent's input: who stopped, and the owner's
 *  last request there when it is known (capped). Pure. */
export function continueInAgentText(fromAgent: string, lastRequest: string | null | undefined): string {
  const head = t('usageLimit.handoffNote', { agent: fromAgent });
  const last = lastRequest?.trim();
  if (!last) return head;
  const quoted = last.length > HANDOFF_REQUEST_MAX ? `${last.slice(0, HANDOFF_REQUEST_MAX).trimEnd()}…` : last;
  return `${head}\n\n${t('usageLimit.handoffLastRequest')}\n${quoted}`;
}

/** The owner's last request in a pane's agent conversation, or null. */
async function lastRequestOf(ptyId: string): Promise<string | null> {
  try {
    const page = await window.electronAPI?.chat?.snapshot?.(ptyId);
    const last = [...(page?.events ?? [])].reverse().find((e) => e.kind === 'user_text');
    return last && last.kind === 'user_text' ? last.text : null;
  } catch {
    return null;
  }
}

/** Resolves true once `ptyId` shows `agent` with its prompt up, false on timeout. */
function agentReady(ptyId: string, agent: AgentId, timeoutMs: number): Promise<boolean> {
  const ready = (): boolean => {
    const a = useStore.getState().surfaceAgent[ptyId];
    return !!a && a.slug === agent && READY.includes(a.status);
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
    const unsubscribe = useStore.subscribe(() => {
      if (!ready()) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * Open `agent` in a new tab of the held pane and type the handoff note into
 * its input without sending it. False when the tab could not open or the
 * agent never showed its prompt (the owner is told; nothing is typed).
 */
export async function continueInAgent(req: {
  heldPtyId: string;
  fromAgent: string;
  agent: AgentId;
  workspaceId: string;
  paneId: string;
  cwd?: string;
}, timeoutMs = AGENT_READY_TIMEOUT_MS): Promise<boolean> {
  const row = agentRow(req.agent);
  const name = row?.display ?? req.agent;
  const lastRequest = await lastRequestOf(req.heldPtyId);
  const tab = await openTerminalTab({
    initialCommand: row?.launcher ?? req.agent,
    title: name,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    target: { workspaceId: req.workspaceId, paneId: req.paneId },
  });
  if (!tab) return false;
  if (!(await agentReady(tab.ptyId, req.agent, timeoutMs))) {
    useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueInAgentNotReady', { agent: name }) });
    return false;
  }
  const term = terminalRegistry.get(tab.ptyId);
  const modes = (term as unknown as { modes?: { bracketedPasteMode?: boolean } } | undefined)?.modes ?? null;
  await pastePtyChunked((d) => window.electronAPI.pty.write(tab.ptyId, d), continueInAgentText(req.fromAgent, lastRequest), modes);
  term?.focus();
  return true;
}
