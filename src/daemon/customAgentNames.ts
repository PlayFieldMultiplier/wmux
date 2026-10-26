// The operator's custom agents as the process tracker needs them: each process
// name → the agent's display name. Main owns `custom-agents.json` (Settings →
// Roles & fan-out → Custom agents); the daemon reads it through main's own
// loader (src/main/worktask/customAgents.ts), so both sides keep and drop the
// same entries. A missing or unreadable file is no custom agents.
//
// A name found here only labels a pane. It never becomes an AgentSlug, so the
// canonical identity, resume, hooks, transcripts and recovery never see it.

import { loadCustomAgentsReport } from '../main/worktask/customAgents';
import { customAgentProcessNames } from '../shared/customAgents';

export class CustomAgentNames {
  private built: { report: object; names: ReadonlyMap<string, string> } | undefined;

  constructor(private readonly dir: string) {}

  /** Process name (customProcessNameForm) → display name. */
  names(): ReadonlyMap<string, string> {
    // The loader returns the same report object until the file changes.
    const report = loadCustomAgentsReport(this.dir);
    if (this.built?.report === report) return this.built.names;
    const names = new Map<string, string>();
    for (const agent of report.agents) {
      for (const name of customAgentProcessNames(agent)) names.set(name, agent.name);
    }
    this.built = { report, names };
    return names;
  }
}
