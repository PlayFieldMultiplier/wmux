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
  CUSTOM_AGENTS_FILE_MAX,
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

type CustomAgentsReport = { agents: CustomAgent[]; dropped: CustomAgentDropped[]; unreadable?: true };

/** The last read per file, keyed by its mtime and size: input.send consults
 *  the list on every line typed into a role-bound pane. */
const cache = new Map<string, { mtimeMs: number; size: number; report: CustomAgentsReport }>();

/** The custom agents in force plus what could not be kept (shown in Settings). */
export function loadCustomAgentsReport(dir?: string): CustomAgentsReport {
  const p = getCustomAgentsPath(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    cache.delete(p);
    return { agents: [], dropped: [] };
  }
  const hit = cache.get(p);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.report;
  let report: CustomAgentsReport;
  try {
    const raw = JSON.parse(readCapped(p)) as { agents?: unknown };
    report = normalizeCustomAgentsReport(raw?.agents, { platform: process.platform });
  } catch {
    report = { agents: [], dropped: [], unreadable: true };
  }
  cache.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, report });
  return report;
}

/** The file's text, read through one descriptor so the size checked is the
 *  size read. The daemon reads this file too: an oversized one is unreadable. */
function readCapped(p: string): string {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > CUSTOM_AGENTS_FILE_MAX) throw new Error('custom-agents.json is too large');
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
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
    // A preset row running it unattended runs exactly these flags: changing
    // them changes what that preset does, and clearing them drops its switch.
    if (use.unattendedPins.length > 0 && (old?.unattendedFlags ?? '') !== (next.unattendedFlags ?? '')) {
      const by = use.unattendedPins.join(', ');
      return { ok: false, code: 'unattended-in-use', params: { stem, by }, error: `"${stem}" runs unattended in ${by}; its unattended flags cannot change` };
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
  // What was just written is what is in force, whatever the clock's resolution.
  try {
    const stat = fs.statSync(p);
    cache.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, report: { agents: v.agents, dropped: [] } });
  } catch {
    cache.delete(p);
  }
  return { ok: true, agents: v.agents };
}
