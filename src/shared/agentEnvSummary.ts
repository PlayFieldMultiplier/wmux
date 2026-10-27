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

// Sized so a full summary stays inside the desktop bridge's 128 KiB reply.
export const AGENT_ENV_LIMITS = Object.freeze({
  agents: 32,
  items: 256,
  instructions: 16,
  nameChars: 120,
  versionChars: 64,
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
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const SOURCES = new Set(['user', 'project', 'plugin', 'wmux', 'builtin', 'managed']);
// A name or version, on one line and without control characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f]+$/;
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

function item(raw: unknown): AgentEnvItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const agent = text(r.agent, AGENT_ENV_LIMITS.nameChars);
  const name = text(r.name, AGENT_ENV_LIMITS.nameChars);
  const source = typeof r.source === 'string' && SOURCES.has(r.source) ? r.source : null;
  return agent && name && source ? { agent, name, source } : null;
}

function items(raw: unknown): AgentEnvItem[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.slice(0, AGENT_ENV_LIMITS.items).map(item).filter((x): x is AgentEnvItem => x !== null);
  return byKey(rows, (r) => `${r.agent}\u0000${r.name}\u0000${r.source}`);
}

/**
 * A summary as another PC sent it, or null when it is not one (another
 * schema, or not the shape). Malformed rows are dropped, never trusted; every
 * list is capped.
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
  return {
    schema: AGENT_ENV_SCHEMA,
    wmuxVersion,
    agents: byKey(agents, (a) => a.agent),
    skills: items(r.skills),
    mcpServers: items(r.mcpServers),
    instructions: byKey(instructions, (i) => i.file),
  };
}

export interface AgentEnvParts {
  wmuxVersion: string;
  /** The surfaces inventories (claude, codex, agy). */
  inventories: ProviderInventory[];
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
    .map((it) => ({ agent: inv.provider, name: it.name, source: it.source })));
  // Through the same parser another PC's summary goes through: one set of bounds.
  const parsed = parseAgentEnvSummary({
    schema: AGENT_ENV_SCHEMA,
    wmuxVersion: parts.wmuxVersion,
    agents,
    skills: kindRows('skill'),
    mcpServers: kindRows('mcp-server'),
    instructions: parts.instructions,
  });
  if (!parsed) throw new Error('agent env summary: wmux version is not a version');
  return parsed;
}
