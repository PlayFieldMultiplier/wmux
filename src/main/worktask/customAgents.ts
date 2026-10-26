// ─── Custom agents (Settings → Roles & fan-out → Custom agents) ───────────────
//
// Operator data, kept main-side next to fanout-presets.json and for the same
// reason: a custom agent decides which executable a role or a fan-out preset
// row runs, so only the Settings IPC writes it. No pipe, A2A, phone or
// remote-spawn handler reads a definition from its caller.
//
// A missing file is no custom agents. A file that exists but cannot be parsed
// is also none: a preset row naming one is then dropped (and shown in
// Settings) rather than launched on a guess.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  customAgentStem,
  normalizeCustomAgentsReport,
  validateCustomAgents,
  type CustomAgent,
  type CustomAgentDropped,
  type CustomAgentIssue,
} from '../../shared/customAgents';

export function getCustomAgentsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'custom-agents.json');
}

/** The custom agents in force plus what could not be kept (shown in Settings). */
export function loadCustomAgentsReport(
  dir?: string,
): { agents: CustomAgent[]; dropped: CustomAgentDropped[]; unreadable?: true } {
  const p = getCustomAgentsPath(dir);
  if (!fs.existsSync(p)) return { agents: [], dropped: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { agents?: unknown };
    return normalizeCustomAgentsReport(raw?.agents);
  } catch {
    return { agents: [], dropped: [], unreadable: true };
  }
}

export function loadCustomAgents(dir?: string): CustomAgent[] {
  return loadCustomAgentsReport(dir).agents;
}

/**
 * Replace the whole list. Strict: the first problem is reported and nothing is
 * written. `inUse` names the stems something still launches (the saved fan-out
 * presets); dropping or renaming one of those is refused, so a preset row never
 * points at an agent that is gone.
 */
export async function saveCustomAgents(
  input: unknown,
  inUse: ReadonlyMap<string, readonly string[]>,
  dir?: string,
): Promise<{ ok: true; agents: CustomAgent[] } | ({ ok: false } & CustomAgentIssue)> {
  const v = validateCustomAgents(input);
  if (!v.ok) return v;
  const kept = new Set(v.agents.map(customAgentStem));
  for (const [stem, users] of inUse) {
    if (!kept.has(stem)) {
      const by = users.join(', ');
      return { ok: false, code: 'agent-in-use', params: { stem, by }, error: `"${stem}" is still used by ${by}` };
    }
  }
  const p = getCustomAgentsPath(dir);
  // One backup of what is being replaced: entries the loader dropped stay
  // recoverable from here.
  if (fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, `${p}.bak`);
    } catch {
      // best-effort — the new list is still written
    }
  }
  await atomicWriteJSON(p, { agents: v.agents });
  return { ok: true, agents: v.agents };
}
