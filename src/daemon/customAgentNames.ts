// The operator's custom agents as the process tracker needs them: each process
// name → the agent's display name. Main owns `custom-agents.json` (Settings →
// Roles & fan-out → Custom agents); the daemon reads it through main's own
// loader (src/main/worktask/customAgents.ts), so both sides keep and drop the
// same entries. A missing or unreadable file is no custom agents.
//
// A name found here only labels a pane. It never becomes an AgentSlug, so the
// canonical identity, resume, hooks, transcripts and recovery never see it.

import { loadCustomAgentsReport } from '../main/worktask/customAgents';
import { customAgentLabelAllowed, customAgentProcessNames } from '../shared/customAgents';

/** How long one read of the file answers: a labelled pane asks on every
 *  activity event, and a Settings save is seen within this. */
const RECHECK_MS = 2_000;

export class CustomAgentNames {
  private built: { report: object; names: ReadonlyMap<string, string>; at: number } | undefined;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Process name (customProcessNameForm) → display name. */
  names(): ReadonlyMap<string, string> {
    if (this.built && this.now() - this.built.at < RECHECK_MS) return this.built.names;
    // The loader returns the same report object until the file changes.
    const report = loadCustomAgentsReport(this.dir);
    if (this.built?.report === report) {
      this.built.at = this.now();
      return this.built.names;
    }
    const names = new Map<string, string>();
    for (const agent of report.agents) {
      // Named like a registry agent: it launches, but its name never labels a pane.
      if (!customAgentLabelAllowed(agent.name)) continue;
      for (const name of customAgentProcessNames(agent)) names.set(name, agent.name);
    }
    this.built = { report, names, at: this.now() };
    return names;
  }
}
