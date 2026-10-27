// The differences between paired PCs' agent environments
// (shared/agentEnvSummary.ts). Pure. Only PCs that answered with a summary are
// compared; the others are listed with why, never read as "has nothing".

import { agentEnvItemKey, type AgentEnvItem, type AgentEnvSummary } from './agentEnvSummary';

/** Why a PC was compared or not. `unsupported`: its wmux predates the route. */
export type AgentEnvHostStatus = 'ok' | 'unsupported' | 'unreachable' | 'auth-rejected' | 'insecure-transport' | 'unavailable';

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
  /** Skills and servers: where it is configured, and what it belongs to. */
  source?: string;
  parent?: string;
  /**
   * Per compared PC: the version or the file hash; for a skill or server,
   * 'on' or 'off'. Null when that PC does not have it. A PC whose list for
   * that agent is not fully known is left out of the row.
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

type Key = { kind: AgentEnvDiffKind; agent?: string; name: string; source?: string; parent?: string };

function itemRow(kind: 'skill' | 'mcpServer', i: AgentEnvItem): Key & { key: string; value: string } {
  return {
    kind, agent: i.agent, name: i.name, source: i.source, ...(i.parent ? { parent: i.parent } : {}),
    key: `${kind}\u0000${agentEnvItemKey(i)}`, value: i.enabled === false ? 'off' : 'on',
  };
}

function rowsOf(s: AgentEnvSummary): Array<Key & { key: string; value: string | null }> {
  return [
    { kind: 'wmux', name: 'wmux', key: 'wmux', value: s.wmuxVersion },
    ...s.agents.map((a) => ({ kind: 'agent' as const, name: a.agent, key: `agent\u0000${a.agent}`, value: a.version })),
    ...s.skills.map((i) => itemRow('skill', i)),
    ...s.mcpServers.map((i) => itemRow('mcpServer', i)),
    ...s.instructions.map((i) => ({ kind: 'instruction' as const, name: i.file, key: `instruction\u0000${i.file}`, value: i.unreadable ? 'unreadable' : i.sha256 })),
  ];
}

/**
 * Whether a PC's silence on this row means it has none, or that it was not
 * checked. Every agent and instruction file a PC checks has a row (null when
 * absent), so no row there means not checked: another wmux build's list, or an
 * inventory that could not be read. Skills and servers are absent only when
 * that agent's list was read in full.
 */
function knownAbsent(row: Key, s: AgentEnvSummary): boolean {
  if (row.kind !== 'skill' && row.kind !== 'mcpServer') return false;
  const list = row.kind === 'skill' ? 'skills' : 'mcpServers';
  return !s.truncated?.includes(list) && !(row.agent !== undefined && s.incomplete?.includes(row.agent));
}

export function diffAgentEnvs(hosts: readonly AgentEnvHost[]): AgentEnvDiff {
  const compared = hosts.filter((h): h is AgentEnvHost & { summary: AgentEnvSummary } => h.status === 'ok' && h.summary !== null);
  const skipped = hosts.filter((h) => !(h.status === 'ok' && h.summary !== null))
    .map((h) => ({ hostId: h.hostId, status: h.status === 'ok' ? 'unavailable' as const : h.status }));
  const table = new Map<string, Key & { values: Record<string, string | null> }>();
  compared.forEach((host) => {
    for (const { key, value, ...r } of rowsOf(host.summary)) {
      let row = table.get(key);
      if (!row) {
        row = { ...r, values: {} };
        table.set(key, row);
      }
      row.values[host.hostId] = value;
    }
  });
  const rows: AgentEnvDiffRow[] = [];
  for (const row of table.values()) {
    // A PC that does not list it has none of it, when its list is complete.
    for (const host of compared) {
      if (!(host.hostId in row.values) && knownAbsent(row, host.summary)) row.values[host.hostId] = null;
    }
    const distinct = new Set(Object.values(row.values));
    if (distinct.size > 1) rows.push(row);
  }
  const order: AgentEnvDiffKind[] = ['wmux', 'agent', 'instruction', 'mcpServer', 'skill'];
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)
    || (a.agent ?? '').localeCompare(b.agent ?? '') || a.name.localeCompare(b.name)
    || (a.source ?? '').localeCompare(b.source ?? '') || (a.parent ?? '').localeCompare(b.parent ?? ''));
  return { compared: compared.map((h) => h.hostId), skipped, rows };
}
