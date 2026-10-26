// The operator's custom agents as the process tracker needs them: each process
// name → the agent's display name. Main owns `custom-agents.json` (Settings →
// Roles & fan-out → Custom agents, src/main/worktask/customAgents.ts); the
// daemon only reads it, through the same validator, and re-reads it when the
// file changes. A missing or unreadable file is no custom agents.
//
// A name found here only labels a pane. It never becomes an AgentSlug, so the
// canonical identity, resume, hooks, transcripts and recovery never see it.

import fs from 'node:fs';
import path from 'node:path';
import { customAgentProcessNames, normalizeCustomAgentsReport } from '../shared/customAgents';

export class CustomAgentNames {
  private cached: { mtimeMs: number; size: number; names: ReadonlyMap<string, string> } | undefined;

  constructor(private readonly dir: string) {}

  /** Process name (lower-case, extension dropped) → display name. */
  names(): ReadonlyMap<string, string> {
    const file = path.join(this.dir, 'custom-agents.json');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.cached = undefined;
      return EMPTY;
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) return this.cached.names;
    let names: ReadonlyMap<string, string> = EMPTY;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents?: unknown };
      const map = new Map<string, string>();
      for (const agent of normalizeCustomAgentsReport(raw?.agents).agents) {
        for (const name of customAgentProcessNames(agent)) map.set(name, agent.name);
      }
      names = map;
    } catch {
      // unreadable: no custom agents until the file changes
    }
    this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, names };
    return names;
  }
}

const EMPTY: ReadonlyMap<string, string> = new Map();
