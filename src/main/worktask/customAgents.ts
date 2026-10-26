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
import type { CustomAgentUse } from './fanoutPresets';
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
    return normalizeCustomAgentsReport(raw?.agents, { platform: process.platform });
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
  inUse: ReadonlyMap<string, CustomAgentUse>,
  dir?: string,
): Promise<{ ok: true; agents: CustomAgent[] } | ({ ok: false } & CustomAgentIssue)> {
  const v = validateCustomAgents(input, { platform: process.platform });
  if (!v.ok) return v;
  const before = loadCustomAgents(dir);
  for (const [stem, use] of inUse) {
    const next = v.agents.find((a) => customAgentStem(a) === stem);
    if (!next) {
      const by = use.users.join(', ');
      return { ok: false, code: 'agent-in-use', params: { stem, by }, error: `"${stem}" is still used by ${by}` };
    }
    // A pinned model goes after the model flag: a changed or removed flag would
    // drop those rows on the next load, and their pins with them.
    const old = before.find((a) => customAgentStem(a) === stem);
    if (use.modelPins.length > 0 && (old?.modelFlag ?? '') !== (next.modelFlag ?? '')) {
      const by = use.modelPins.join(', ');
      return { ok: false, code: 'model-in-use', params: { stem, by }, error: `"${stem}" has a model pinned by ${by}; its model flag cannot change` };
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
