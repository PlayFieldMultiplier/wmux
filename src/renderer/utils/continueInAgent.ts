// Usage-limit card → "Continue in <agent>": a held pane's work goes on in
// another installed, signed-in agent. A new tab in the same pane starts that
// agent in the pane's folder; once its prompt is up, a handoff note is pasted
// into its input and never submitted, so the owner reads it before sending.
// The held tab stays as it was; the two tabs name each other in their tooltips.

import { useStore } from '../stores';
import { t } from '../i18n';
import { terminalRegistry } from '../hooks/useTerminal';
import { agentRow } from '../../shared/agentIdentity';
import type { AgentId } from '../../shared/agentSetup';
import type { AgentStatus } from '../../shared/types';
import { USAGE_LIMIT_CONTINUE_PROMPT } from '../../shared/usageLimit';
import { classifyLaunchScreen } from '../../shared/agentFirstRun';
import { redactSecrets } from '../../shared/redactSecrets';
import type { DiffNumstat } from '../../shared/diffParse';
import type { TranscriptPage, TurnEvent } from '../../shared/transcript/turnEvents';
import { chatComposerDraft } from '../components/Chat/chatDrafts';
import { openTerminalTab } from './accountLogin';
import { pastePtyChunked } from './clipboardChunk';

/** Longest request the handoff note quotes. */
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

/** What the handoff note is built from, gathered without any model call:
 *  the held conversation (chat.snapshot), the folder's git state (diff.read)
 *  and the tab's own input line. */
export interface HandoffFacts {
  /** The owner's requests, oldest first; the first is the earliest one read. */
  requests: string[];
  /** The agent's last reply, as prose. */
  reply: string | null;
  /** Plan or todo files the agent wrote. */
  planFiles: string[];
  branch: string | null;
  /** The folder's uncommitted changes, `git diff --stat` style. */
  files: readonly DiffNumstat[];
  transcriptPath: string | null;
  /** Text typed into the held agent's input and never sent. */
  draft: string | null;
}

/** Longest reply excerpt the note quotes (its end, where a summary sits). */
export const HANDOFF_REPLY_MAX = 1500;
/** Most changed files the note lists. */
export const HANDOFF_FILES_MAX = 30;
/** Older transcript pages read back looking for the first request. */
const HANDOFF_PAGES_MAX = 8;

/** A Write/Edit input's `file_path`, or a Codex patch's file header. */
const WRITTEN_PATH_RE = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)+)"|^\*\*\* (?:Add|Update) File: (.+)$/gm;
/** A plan or todo file: under a plans/todos folder, or named for one. */
const PLAN_FILE_RE = /(?:^|[\\/])(?:plans?|todos?)[\\/][^\\/]+$|(?:^|[\\/])[^\\/]*(?:plan|todo)[^\\/]*\.(?:md|txt)$/i;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** The note pasted into the new agent's input: who stopped, the first and
 *  latest requests, the end of the last reply, plan files, the branch and its
 *  changes, the transcript, and the draft when the owner chose to carry it.
 *  Free text is masked for keys and tokens. Pure. */
export function continueInAgentText(fromAgent: string, facts: Partial<HandoffFacts> | null, opts: { carryDraft?: boolean } = {}): string {
  const parts = [t('usageLimit.handoffNote', { agent: fromAgent })];
  const quote = (text: string) => redactSecrets(cap(text.trim(), HANDOFF_REQUEST_MAX));
  const requests = (facts?.requests ?? []).filter((r) => r.trim());
  if (requests.length === 1) parts.push(`${t('usageLimit.handoffLastRequest')}\n${quote(requests[0])}`);
  if (requests.length > 1) {
    parts.push(`${t('usageLimit.handoffFirstRequest')}\n${quote(requests[0])}`);
    const recent = requests.slice(Math.max(1, requests.length - 3));
    parts.push(`${t('usageLimit.handoffRecentRequests')}\n${recent.map((r, i) => `${i + 1}. ${quote(r)}`).join('\n')}`);
  }
  const reply = facts?.reply?.trim();
  if (reply) {
    const end = reply.length > HANDOFF_REPLY_MAX ? `…${reply.slice(-HANDOFF_REPLY_MAX).trimStart()}` : reply;
    parts.push(`${t('usageLimit.handoffLastReply', { agent: fromAgent })}\n${redactSecrets(end)}`);
  }
  if (facts?.planFiles?.length) parts.push(`${t('usageLimit.handoffPlanFiles')}\n${facts.planFiles.join('\n')}`);
  const files = facts?.files ?? [];
  const git: string[] = [];
  if (facts?.branch) git.push(t('usageLimit.handoffBranch', { branch: facts.branch }));
  if (files.length) {
    git.push(t('usageLimit.handoffChanges'));
    for (const f of files.slice(0, HANDOFF_FILES_MAX)) {
      git.push(` ${f.path} | ${f.additions === null ? 'bin' : `+${f.additions} -${f.deletions ?? 0}`}`);
    }
    if (files.length > HANDOFF_FILES_MAX) git.push(` ${t('usageLimit.handoffMoreFiles', { count: files.length - HANDOFF_FILES_MAX })}`);
    git.push(t('usageLimit.handoffCheckChanges'));
  }
  if (git.length) parts.push(git.join('\n'));
  if (facts?.transcriptPath) parts.push(t('usageLimit.handoffTranscript', { path: facts.transcriptPath }));
  const draft = facts?.draft?.trim();
  if (opts.carryDraft && draft) parts.push(`${t('usageLimit.handoffDraft')}\n${redactSecrets(draft)}`);
  return parts.join('\n\n');
}

/** The owner's requests in a page of events. wmux's own continue message
 *  (sent at a reset) is not one. */
function requestsIn(events: readonly TurnEvent[]): string[] {
  return events.flatMap((e) => (e.kind === 'user_text' && !e.folded && e.text.trim() && e.text.trim() !== USAGE_LIMIT_CONTINUE_PROMPT ? [e.text] : []));
}

/** Plan or todo files the agent wrote in a page of events. */
function planFilesIn(events: readonly TurnEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== 'tool_use' || !e.input?.inline) continue;
    for (const m of e.input.inline.matchAll(WRITTEN_PATH_RE)) {
      const raw = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2].trim();
      if (PLAN_FILE_RE.test(raw)) out.push(raw);
    }
  }
  return out;
}

/** The held conversation's requests, last reply and plan files. The tail page
 *  gives the latest ones; older pages are read back (bounded) for the first
 *  request and for plan files written earlier. */
async function conversationOf(ptyId: string): Promise<Pick<HandoffFacts, 'requests' | 'reply' | 'planFiles'>> {
  const empty = { requests: [], reply: null, planFiles: [] };
  const snapshot = window.electronAPI?.chat?.snapshot;
  if (!snapshot) return empty;
  try {
    let page = await snapshot(ptyId);
    if (!page) return empty;
    const requests = requestsIn(page.events);
    const last = [...page.events].reverse()
      .find((e) => e.kind === 'assistant_text' && !e.thinking && !e.folded && e.text.trim());
    // eslint-disable-next-line no-control-regex -- a code block's inline marker is NUL-delimited
    const reply = last && last.kind === 'assistant_text' ? last.text.replace(/\u0000code:\d+\u0000/g, '[code]') : null;
    const planFiles = planFilesIn(page.events);
    let first: string | null = null;
    for (let n = 0; page.hasMore && n < HANDOFF_PAGES_MAX; n++) {
      const older: TranscriptPage | null = await snapshot(ptyId, page.cursor.headOffset).catch(() => null);
      if (!older || older.cursor.headOffset >= page.cursor.headOffset) break;
      page = older;
      first = requestsIn(page.events)[0] ?? first;
      planFiles.unshift(...planFilesIn(page.events));
    }
    return { requests: first !== null ? [first, ...requests] : requests, reply, planFiles: [...new Set(planFiles)] };
  } catch {
    return empty;
  }
}

/** The branch and uncommitted changes of `cwd` (the pane's folder). */
async function gitOf(ptyId: string, cwd: string | undefined): Promise<Pick<HandoffFacts, 'branch' | 'files'>> {
  const reported = useStore.getState().surfaceGitBranch[ptyId] ?? null;
  if (!cwd) return { branch: reported, files: [] };
  try {
    const diff = await window.electronAPI?.diff?.read?.(cwd, '', 'workspace');
    if (diff?.ok) return { branch: diff.snapshot.targetBranch || reported, files: diff.numstat };
  } catch { /* not a repository, or unreadable: the branch the pane reported */ }
  return { branch: reported, files: [] };
}

/** Text typed into `ptyId`'s agent input and never sent: the Chat view
 *  composer's draft, else the terminal's cursor row after the agent's prompt
 *  glyph (`>` `❯` `›`), dimmed suggestion text left out. Only that row: a
 *  multi-line draft is read from its last line. */
export function unsentDraftOf(ptyId: string): string | null {
  const chat = chatComposerDraft(ptyId)?.trim();
  if (chat) return chat;
  const term = terminalRegistry.get(ptyId);
  const buf = term?.buffer?.active;
  const line = buf?.getLine(buf.baseY + buf.cursorY);
  if (!line) return null;
  let row = '';
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    row += cell.isDim() ? ' ' : (cell.getChars() || ' ');
  }
  const typed = /^[\s│┃|]*[>❯›»]\s(.*?)[\s│┃|]*$/.exec(row)?.[1]?.trim();
  return typed || null;
}

/** Everything the handoff note is built from, for the held pane `ptyId`. */
export async function handoffFacts(ptyId: string, cwd: string | undefined): Promise<HandoffFacts> {
  const [conversation, git] = await Promise.all([conversationOf(ptyId), gitOf(ptyId, cwd)]);
  const transcriptPath = useStore.getState().resumeBindingByPtyId[ptyId]?.transcriptPath ?? null;
  return { ...conversation, ...git, transcriptPath, draft: unsentDraftOf(ptyId) };
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
  /** The note as the card previewed it; built here when absent. */
  note?: string;
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
  const note = req.note ?? continueInAgentText(req.fromAgent, await handoffFacts(req.heldPtyId, req.cwd));
  const tab = await openTerminalTab({
    initialCommand: row?.launcher ?? req.agent,
    title: name,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    target: { workspaceId: req.workspaceId, paneId: req.paneId },
  });
  if (!tab) return false;
  useStore.getState().linkContinuedSurfaces(req.heldPtyId, tab.ptyId);
  const ready = await agentReady(tab.ptyId, req.agent, timeoutMs);
  const term = terminalRegistry.get(tab.ptyId);
  if (!ready || !term || !takesBracketedPaste(tab.ptyId) || onLaunchScreen(tab.ptyId)) {
    useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueInAgentNotReady', { agent: name }) });
    return false;
  }
  await pastePtyChunked((d) => window.electronAPI.pty.write(tab.ptyId, d), note, { bracketedPasteMode: true });
  term.focus();
  return true;
}
