// ─── "This ended task's agent was seen gone", kept across restarts ─────────
//
// The fan-out live cap and the agent budget free an ended task's slot only
// once its agent is known gone (#2387, #2393). That used to be known only
// from the last live read of the daemon's sessions, in memory: after a cold
// restart there was no read yet, or the daemon could not answer while it
// recovered its WSL sessions, and every ended task counted as live again.
//
// A fact is written when a good read sees an ended task's workspace with no
// agent left, when the task's panes are gone (its workspace closed), and when
// the task is closed with its panes stopped. It names the sessions the task's
// workspace held then and when it was seen, under
// `<wmuxDir>/factory/agent-gone.json`.
//
// Updates are one-way: a live read may add a fact, and missing or failed data
// never removes one. A fact is cleared only when the task really runs again:
// its row goes back to an open status, its reclaim record becomes `resumed`,
// a new worker session is launched for it, or a good read sees an agent
// running in its workspace again. A task whose agent was running at shutdown
// has no fact, so it holds its slot until a read sees it exit.
//
// A file this version cannot read means "no facts": nothing is written over
// it, and admission never fails for that reason.

import path from 'node:path';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const AGENT_GONE_FILENAME = 'agent-gone.json';
export const AGENT_GONE_VERSION = 1 as const;
/** Facts kept (oldest dropped first). */
export const AGENT_GONE_MAX = 2000;

export interface AgentGoneFact {
  taskId: string;
  /** The task's workspace when its agent was seen gone. */
  taskWorkspaceId: string;
  /** The sessions that workspace held then ([]: its panes were gone). */
  sessions: string[];
  at: number;
}

function isFact(v: unknown): v is AgentGoneFact {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && r.taskId.length > 0 && typeof r.taskWorkspaceId === 'string'
    && Array.isArray(r.sessions) && r.sessions.every((s) => typeof s === 'string')
    && typeof r.at === 'number' && Number.isFinite(r.at);
}

export class AgentGoneFacts {
  private readonly facts = new Map<string, AgentGoneFact>();
  private readonly persister: FilePersister;
  /** False once the file could not be read: facts then live in memory only. */
  private writable = true;
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly warn: (line: string) => void = (l) => console.warn(l)) {
    this.persister = createFilePersister(file, () => ({ version: AGENT_GONE_VERSION, facts: [...this.facts.values()] }));
  }

  static at(wmuxDir: string): AgentGoneFacts {
    return new AgentGoneFacts(path.join(wmuxDir, 'factory', AGENT_GONE_FILENAME));
  }

  /** Read the file (missing → none). An unreadable file or one of another
   *  version leaves no facts and is never written over. Never throws. */
  load(): void {
    this.facts.clear();
    try {
      const raw = readVersionedFile(this.file, AGENT_GONE_VERSION);
      const list = raw && Array.isArray(raw.facts) ? raw.facts : [];
      for (const f of list) if (isFact(f)) this.facts.set(f.taskId, { ...f, sessions: [...f.sessions] });
      this.writable = true;
    } catch (err) {
      this.writable = false;
      this.warn(`[factory] agent-gone facts not read, none are kept on disk: ${String(err)}`);
    }
  }

  get(taskId: string): AgentGoneFact | null {
    const f = this.facts.get(taskId);
    return f ? { ...f, sessions: [...f.sessions] } : null;
  }

  all(): AgentGoneFact[] {
    return [...this.facts.values()].map((f) => ({ ...f, sessions: [...f.sessions] }));
  }

  /** Record that the task's agent was seen gone. A fact already held for the
   *  same workspace and sessions is kept as it is (no write). */
  note(fact: AgentGoneFact): void {
    const prior = this.facts.get(fact.taskId);
    const sessions = [...new Set(fact.sessions)].sort();
    if (prior && prior.taskWorkspaceId === fact.taskWorkspaceId && prior.sessions.length === sessions.length
      && prior.sessions.every((s, i) => s === sessions[i])) return;
    this.facts.delete(fact.taskId);
    this.facts.set(fact.taskId, { taskId: fact.taskId, taskWorkspaceId: fact.taskWorkspaceId, sessions, at: fact.at });
    while (this.facts.size > AGENT_GONE_MAX) {
      const oldest = this.facts.keys().next();
      if (oldest.done) break;
      this.facts.delete(oldest.value);
    }
    this.persist();
  }

  /** The task runs again (`why` is logged): its fact goes. */
  clear(taskId: string, why: string): void {
    if (!this.facts.delete(taskId)) return;
    console.log(`[factory] agent-gone fact cleared for ${taskId}: ${why}`);
    this.persist();
  }

  /** Resolves once the writes scheduled so far are on disk (or failed). */
  written(): Promise<void> {
    return this.lastWrite;
  }

  private persist(): void {
    if (!this.writable) return;
    this.lastWrite = this.persister.schedule().catch((err) => this.warn(`[factory] agent-gone facts not written: ${String(err)}`));
  }
}

let hosted: AgentGoneFacts | null = null;

/** Set by the worker lifecycle host (null: none). */
export function setAgentGoneFacts(next: AgentGoneFacts | null): void {
  hosted = next;
}

/** A new worker session was launched for `taskId` (a respawn or a resume):
 *  its agent runs again, so a fact that says it is gone goes. Never throws. */
export function noteTaskWorkerLaunched(taskId: string): void {
  try {
    hosted?.clear(taskId, 'a new worker session was launched');
  } catch {
    /* best effort: the next good read decides */
  }
}

/** A task closed with its worktree's panes stopped (TaskCloseService): its
 *  agent is gone. Never throws. */
export function noteTaskPanesStopped(taskId: string, taskWorkspaceId: string, sessionIds: readonly string[], at: number = Date.now()): void {
  try {
    hosted?.note({ taskId, taskWorkspaceId, sessions: [...sessionIds], at });
  } catch {
    /* best effort: the next good read decides */
  }
}
