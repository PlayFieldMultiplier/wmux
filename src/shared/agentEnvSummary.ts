// A read-only summary of one PC's agent environment, for comparing paired PCs
// (shared/agentEnvDiff.ts). Desktop-internal: served at AGENT_ENV_ROUTE to a
// paired device and read by the desktop's own `pc.envDiff`; not part of the
// phone client contract.
//
// It carries names, versions and content hashes only: no file contents, no
// paths beyond the fixed home-relative instruction file names, no env values,
// commands or arguments. The same bounds apply when building it and when
// reading another PC's, which is untrusted input.

import type { ProviderInventory } from './tokenUsage/surfaceTypes';

export const AGENT_ENV_SCHEMA = 1 as const;
/** The web route a paired device reads it from. */
export const AGENT_ENV_ROUTE = '/api/agent-env';
/** The desktop command the daemon asks main with (DesktopPhoneBridge). */
export const AGENT_ENV_COMMAND = 'agentEnv.summary';

export const AGENT_ENV_LIMITS = Object.freeze({
  agents: 32,
  /** Per list, after de-duplication; the raw list is read up to 4x this. */
  items: 256,
  instructions: 16,
  nameChars: 120,
  versionChars: 64,
  /** The summary as JSON, at most: inside the desktop bridge's 128 KiB reply. */
  summaryBytes: 96 * 1024,
  /** The JSON body read from another PC, at most. */
  bodyBytes: 256 * 1024,
});

export interface AgentEnvAgent {
  agent: string;
  /** `x.y.z` as the agent reports it; null when not installed or not known. */
  version: string | null;
}

/** A skill or MCP server the agent is configured with, by name. */
export interface AgentEnvItem {
  agent: string;
  name: string;
  /** Where it is configured: user, project, plugin, wmux, builtin or managed. */
  source: string;
  /** What it belongs to (e.g. its plugin), by name, when the agent says. */
  parent?: string;
  /** Present only when it is configured but turned off. */
  enabled?: false;
}

export interface AgentEnvInstruction {
  /** Home-relative, e.g. `~/.claude/CLAUDE.md`. */
  file: string;
  /** SHA-256 of the file's bytes as stored (no normalising); null when there is no such file. */
  sha256: string | null;
}

export interface AgentEnvSummary {
  schema: typeof AGENT_ENV_SCHEMA;
  wmuxVersion: string;
  agents: AgentEnvAgent[];
  skills: AgentEnvItem[];
  mcpServers: AgentEnvItem[];
  instructions: AgentEnvInstruction[];
  /** Agents whose configuration could not be read: their items are not known, not absent. */
  incomplete?: string[];
  /** Present when a list was cut to the limits: what is missing is not known. */
  truncated?: true;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const SOURCES = new Set(['user', 'project', 'plugin', 'wmux', 'builtin', 'managed']);
// A name or version: on one line, with no control characters (C0, DEL, C1)
// and none of the invisible or direction-changing ones (zero-width, bidi
// embeddings and isolates) that would make two different names read alike.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+$/;
// A home-relative instruction file name: `~/` then plain path segments,
// none of them `.` or `..`.
const INSTRUCTION_FILE_RE = /^~(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+)+$/;

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max && PRINTABLE_RE.test(v) ? v : null;
}

function byKey<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(key(row))) seen.set(key(row), row);
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/** The identity of a skill or server: the same name from another source or parent is another one. */
export function agentEnvItemKey(r: Pick<AgentEnvItem, 'agent' | 'name' | 'source' | 'parent'>): string {
  return `${r.agent}\u0000${r.source}\u0000${r.parent ?? ''}\u0000${r.name}`;
}

function item(raw: unknown): AgentEnvItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const agent = text(r.agent, AGENT_ENV_LIMITS.nameChars);
  const name = text(r.name, AGENT_ENV_LIMITS.nameChars);
  const source = typeof r.source === 'string' && SOURCES.has(r.source) ? r.source : null;
  if (!agent || !name || !source) return null;
  const parent = r.parent === undefined || r.parent === null ? null : text(r.parent, AGENT_ENV_LIMITS.nameChars);
  return { agent, name, source, ...(parent ? { parent } : {}), ...(r.enabled === false ? { enabled: false as const } : {}) };
}

/** De-duplicated and sorted BEFORE the cap, so two PCs keep the same rows whatever order they listed them in. */
function items(raw: unknown): { rows: AgentEnvItem[]; cut: boolean } {
  if (!Array.isArray(raw)) return { rows: [], cut: false };
  const rows = byKey(raw.slice(0, AGENT_ENV_LIMITS.items * 4).map(item).filter((x): x is AgentEnvItem => x !== null), agentEnvItemKey);
  const cut = raw.length > AGENT_ENV_LIMITS.items * 4 || rows.length > AGENT_ENV_LIMITS.items;
  return { rows: rows.slice(0, AGENT_ENV_LIMITS.items), cut };
}

/** The summary's JSON size, in bytes. */
function bytes(s: AgentEnvSummary): number {
  return new TextEncoder().encode(JSON.stringify(s)).length;
}

/**
 * A summary as another PC sent it, or null when it is not one (another
 * schema, or not the shape). Malformed rows are dropped, never trusted; every
 * list is capped, and the whole is kept inside AGENT_ENV_LIMITS.summaryBytes.
 */
export function parseAgentEnvSummary(raw: unknown): AgentEnvSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== AGENT_ENV_SCHEMA) return null;
  const wmuxVersion = text(r.wmuxVersion, AGENT_ENV_LIMITS.versionChars);
  if (!wmuxVersion || !Array.isArray(r.agents) || !Array.isArray(r.instructions)) return null;
  const agents: AgentEnvAgent[] = [];
  for (const a of r.agents.slice(0, AGENT_ENV_LIMITS.agents)) {
    const row = a as Record<string, unknown> | null;
    const agent = text(row?.agent, AGENT_ENV_LIMITS.nameChars);
    if (!agent) continue;
    agents.push({ agent, version: text(row?.version, AGENT_ENV_LIMITS.versionChars) });
  }
  const instructions: AgentEnvInstruction[] = [];
  for (const i of r.instructions.slice(0, AGENT_ENV_LIMITS.instructions)) {
    const row = i as Record<string, unknown> | null;
    const file = typeof row?.file === 'string' && row.file.length <= AGENT_ENV_LIMITS.nameChars && INSTRUCTION_FILE_RE.test(row.file) ? row.file : null;
    if (!file) continue;
    instructions.push({ file, sha256: typeof row?.sha256 === 'string' && SHA256_RE.test(row.sha256) ? row.sha256 : null });
  }
  const incomplete = Array.isArray(r.incomplete)
    ? byKey(r.incomplete.slice(0, AGENT_ENV_LIMITS.agents).map((a) => text(a, AGENT_ENV_LIMITS.nameChars)).filter((a): a is string => a !== null), (a) => a)
    : [];
  const skills = items(r.skills);
  const mcpServers = items(r.mcpServers);
  const summary: AgentEnvSummary = {
    schema: AGENT_ENV_SCHEMA,
    wmuxVersion,
    agents: byKey(agents, (a) => a.agent),
    skills: skills.rows,
    mcpServers: mcpServers.rows,
    instructions: byKey(instructions, (i) => i.file),
    ...(incomplete.length > 0 ? { incomplete } : {}),
    ...(r.truncated === true || skills.cut || mcpServers.cut ? { truncated: true as const } : {}),
  };
  // Over the byte budget (long or multi-byte names): drop from the end of the
  // longer list until it fits, and say so.
  while (bytes(summary) > AGENT_ENV_LIMITS.summaryBytes && (summary.skills.length > 0 || summary.mcpServers.length > 0)) {
    (summary.skills.length >= summary.mcpServers.length ? summary.skills : summary.mcpServers).pop();
    summary.truncated = true;
  }
  return summary;
}

export interface AgentEnvParts {
  wmuxVersion: string;
  /** The surfaces inventories (claude, codex, agy) that could be read. */
  inventories: ProviderInventory[];
  /** Inventory providers whose read failed. */
  unread?: string[];
  /** Versions of agents read outside the inventories (e.g. gemini, qwen). */
  versions: AgentEnvAgent[];
  instructions: AgentEnvInstruction[];
}

/** This PC's summary from what main already reads: names, versions and hashes only. */
export function buildAgentEnvSummary(parts: AgentEnvParts): AgentEnvSummary {
  const agents: AgentEnvAgent[] = [
    ...parts.inventories.map((inv) => ({ agent: inv.provider, version: inv.cliVersion })),
    ...parts.versions,
  ];
  const kindRows = (kind: 'skill' | 'mcp-server'): AgentEnvItem[] => parts.inventories.flatMap((inv) => inv.items
    .filter((it) => it.kind === kind)
    .map((it) => ({ agent: inv.provider, name: it.name, source: it.source, parent: it.parent ?? undefined, enabled: it.enabled === false ? false as const : undefined })));
  // Through the same parser another PC's summary goes through: one set of bounds.
  const parsed = parseAgentEnvSummary({
    schema: AGENT_ENV_SCHEMA,
    wmuxVersion: parts.wmuxVersion,
    agents,
    skills: kindRows('skill'),
    mcpServers: kindRows('mcp-server'),
    instructions: parts.instructions,
    incomplete: parts.unread ?? [],
  });
  if (!parsed) throw new Error('agent env summary: wmux version is not a version');
  return parsed;
}
