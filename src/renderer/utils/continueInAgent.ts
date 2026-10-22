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
import { USAGE_LIMIT_CONTINUE_PROMPT } from '../../shared/usageLimit';
import { classifyLaunchScreen } from '../../shared/agentFirstRun';
import { openTerminalTab } from './accountLogin';
import { pastePtyChunked } from './clipboardChunk';

/** Longest last request the handoff note quotes. */
export const HANDOFF_REQUEST_MAX = 2000;
/** How long the new agent has to show its prompt. */
export const AGENT_READY_TIMEOUT_MS = 60_000;

/** How often the wait re-reads the terminal's paste mode and screen, which no store event reports. */
const READY_POLL_MS = 250;

/** Agent states with its prompt up and waiting for input. Not
 *  `awaiting_input`: that is a confirm or trust dialog, not the prompt. */
const READY: readonly AgentStatus[] = ['idle', 'waiting', 'complete'];

/** Held panes with a handoff under way, so a second click opens no second tab. */
const inFlight = new Set<string>();

/** The note pasted into the new agent's input: who stopped, and the owner's
 *  last request there when it is known (capped). Pure. */
export function continueInAgentText(fromAgent: string, lastRequest: string | null | undefined): string {
  const head = t('usageLimit.handoffNote', { agent: fromAgent });
  const last = lastRequest?.trim();
  if (!last) return head;
  const quoted = last.length > HANDOFF_REQUEST_MAX ? `${last.slice(0, HANDOFF_REQUEST_MAX).trimEnd()}…` : last;
  return `${head}\n\n${t('usageLimit.handoffLastRequest')}\n${quoted}`;
}

/** The owner's last request in a pane's agent conversation, or null.
 *  wmux's own continue message (sent at a reset) is not one. */
async function lastRequestOf(ptyId: string): Promise<string | null> {
  try {
    const page = await window.electronAPI?.chat?.snapshot?.(ptyId);
    const last = [...(page?.events ?? [])].reverse()
      .find((e) => e.kind === 'user_text' && e.text.trim() !== USAGE_LIMIT_CONTINUE_PROMPT);
    return last && last.kind === 'user_text' ? last.text : null;
  } catch {
    return null;
  }
}

/** True when `ptyId`'s terminal is mounted and takes a bracketed paste. An
 *  unbracketed paste turns every line break into Enter, sending the note line by line. */
function takesBracketedPaste(ptyId: string): boolean {
  const term = terminalRegistry.get(ptyId) as unknown as { modes?: { bracketedPasteMode?: boolean } } | undefined;
  return term?.modes?.bracketedPasteMode === true;
}

/** True when `ptyId`'s visible screen shows an agent launch screen: a trust
 *  dialog, a first-run prompt or any other menu. Pane status can read such a
 *  screen as idle, and the agent may turn bracketed paste on before drawing it. */
function onLaunchScreen(ptyId: string): boolean {
  const term = terminalRegistry.get(ptyId);
  if (!term) return true;
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  return classifyLaunchScreen(rows.join('\n')) !== null;
}

/** Resolves true once `ptyId` shows `agent` with its prompt up, no launch
 *  screen, and a terminal that takes a bracketed paste; false on timeout. The
 *  status arrives over metadata IPC and the screen over the pty stream, in no
 *  fixed order. */
function agentReady(ptyId: string, agent: AgentId, timeoutMs: number): Promise<boolean> {
  const ready = (): boolean => {
    const a = useStore.getState().surfaceAgent[ptyId];
    return !!a && a.slug === agent && READY.includes(a.status) && takesBracketedPaste(ptyId) && !onLaunchScreen(ptyId);
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      unsubscribe();
      resolve(ok);
    };
    const check = () => { if (ready()) finish(true); };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const poll = window.setInterval(check, READY_POLL_MS);
    const unsubscribe = useStore.subscribe(check);
  });
}

/**
 * Open `agent` in a new tab of the held pane and type the handoff note into
 * its input without sending it. False when the tab could not open, the
 * agent never showed its prompt (the owner is told; nothing is typed), or a
 * handoff from this pane is already under way.
 */
export async function continueInAgent(req: {
  heldPtyId: string;
  fromAgent: string;
  agent: AgentId;
  workspaceId: string;
  paneId: string;
  cwd?: string;
}, timeoutMs = AGENT_READY_TIMEOUT_MS): Promise<boolean> {
  if (inFlight.has(req.heldPtyId)) return false;
  inFlight.add(req.heldPtyId);
  try {
    return await handOff(req, timeoutMs);
  } finally {
    inFlight.delete(req.heldPtyId);
  }
}

async function handOff(req: Parameters<typeof continueInAgent>[0], timeoutMs: number): Promise<boolean> {
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
  const ready = await agentReady(tab.ptyId, req.agent, timeoutMs);
  const term = terminalRegistry.get(tab.ptyId);
  if (!ready || !term || !takesBracketedPaste(tab.ptyId) || onLaunchScreen(tab.ptyId)) {
    useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueInAgentNotReady', { agent: name }) });
    return false;
  }
  await pastePtyChunked((d) => window.electronAPI.pty.write(tab.ptyId, d), continueInAgentText(req.fromAgent, lastRequest), { bracketedPasteMode: true });
  term.focus();
  return true;
}
