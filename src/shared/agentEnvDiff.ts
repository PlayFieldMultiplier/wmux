// The differences between paired PCs' agent environments
// (shared/agentEnvSummary.ts). Pure. Only PCs that answered with a summary are
// compared; the others are listed with why, never read as "has nothing".

import type { AgentEnvSummary } from './agentEnvSummary';

/** Why a PC was compared or not. `unsupported`: its wmux predates the route. */
export type AgentEnvHostStatus = 'ok' | 'unsupported' | 'unreachable' | 'auth-rejected' | 'unavailable';

export interface AgentEnvHost {
  /** 'local' for this PC, else the paired host's id. */
  hostId: string;
  name: string;
  status: AgentEnvHostStatus;
  summary: AgentEnvSummary | null;
}

export type AgentEnvDiffKind = 'wmux' | 'agent' | 'skill' | 'mcpServer' | 'instruction';

export interface AgentEnvDiffRow {
  kind: AgentEnvDiffKind;
  /** The agent a row is about (absent for wmux and instruction files). */
  agent?: string;
  /** The skill or MCP server name, the instruction file, or the agent. */
  name: string;
  /**
   * Per compared PC: the version, the source a skill or server is configured
   * from, or the file hash; null when that PC does not have it.
   */
  values: Record<string, string | null>;
}

export interface AgentEnvDiff {
  /** The PCs compared, in the order given. */
  compared: string[];
  /** The PCs left out, with why. */
  skipped: Array<{ hostId: string; status: AgentEnvHostStatus }>;
  /** Only the rows whose values differ between the compared PCs. */
  rows: AgentEnvDiffRow[];
}

type Key = { kind: AgentEnvDiffKind; agent?: string; name: string };

function rowsOf(s: AgentEnvSummary): Array<Key & { value: string | null }> {
  return [
    { kind: 'wmux', name: 'wmux', value: s.wmuxVersion },
    ...s.agents.map((a) => ({ kind: 'agent' as const, name: a.agent, value: a.version })),
    ...s.skills.map((i) => ({ kind: 'skill' as const, agent: i.agent, name: i.name, value: i.source })),
    ...s.mcpServers.map((i) => ({ kind: 'mcpServer' as const, agent: i.agent, name: i.name, value: i.source })),
    ...s.instructions.map((i) => ({ kind: 'instruction' as const, name: i.file, value: i.sha256 })),
  ];
}

export function diffAgentEnvs(hosts: readonly AgentEnvHost[]): AgentEnvDiff {
  const compared = hosts.filter((h): h is AgentEnvHost & { summary: AgentEnvSummary } => h.status === 'ok' && h.summary !== null);
  const skipped = hosts.filter((h) => !(h.status === 'ok' && h.summary !== null))
    .map((h) => ({ hostId: h.hostId, status: h.status === 'ok' ? 'unavailable' as const : h.status }));
  const table = new Map<string, Key & { values: Record<string, string | null> }>();
  compared.forEach((host) => {
    for (const r of rowsOf(host.summary)) {
      const key = `${r.kind}\u0000${r.agent ?? ''}\u0000${r.name}`;
      let row = table.get(key);
      if (!row) {
        row = { kind: r.kind, ...(r.agent !== undefined ? { agent: r.agent } : {}), name: r.name, values: {} };
        table.set(key, row);
      }
      row.values[host.hostId] = r.value;
    }
  });
  const rows: AgentEnvDiffRow[] = [];
  for (const row of table.values()) {
    // A PC that does not list it has none of it.
    for (const host of compared) if (!(host.hostId in row.values)) row.values[host.hostId] = null;
    const distinct = new Set(compared.map((h) => row.values[h.hostId]));
    if (distinct.size > 1) rows.push(row);
  }
  const order: AgentEnvDiffKind[] = ['wmux', 'agent', 'instruction', 'mcpServer', 'skill'];
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)
    || (a.agent ?? '').localeCompare(b.agent ?? '') || a.name.localeCompare(b.name));
  return { compared: compared.map((h) => h.hostId), skipped, rows };
}
