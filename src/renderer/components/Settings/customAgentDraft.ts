// Pure helpers behind Settings → Roles & fan-out → Custom agents.
//
// The editor works on a string-typed draft and turns it into the wire shape
// only on save, where validateCustomAgents — the same check main runs — has
// the final word. No React or i18n imports, so this module is testable in the
// node env.

import {
  customAgentStem,
  validateCustomAgents,
  type CustomAgent,
  type CustomAgentIssue,
} from '../../../shared/customAgents';
import type { FanoutPreset } from '../../../shared/fanoutPreset';
import type { OrchestratorRoleBindings } from '../../../shared/orchestratorRole';

export interface CustomAgentDraft {
  name: string;
  command: string;
  args: string;
  promptFlag: string;
  modelFlag: string;
  unattendedFlags: string;
}

export function emptyCustomAgentDraft(): CustomAgentDraft {
  return { name: '', command: '', args: '', promptFlag: '', modelFlag: '', unattendedFlags: '' };
}

export function draftFromCustomAgent(agent: CustomAgent): CustomAgentDraft {
  return {
    name: agent.name,
    command: agent.command,
    args: agent.args ?? '',
    promptFlag: agent.promptFlag ?? '',
    modelFlag: agent.modelFlag ?? '',
    unattendedFlags: agent.unattendedFlags ?? '',
  };
}

/** Wire shape for a save: an empty field is omitted, never sent empty. */
export function customAgentDraftPayload(draft: CustomAgentDraft): Record<string, string> {
  const out: Record<string, string> = { name: draft.name.trim(), command: draft.command.trim() };
  for (const field of ['args', 'promptFlag', 'modelFlag', 'unattendedFlags'] as const) {
    const v = draft[field].trim();
    if (v) out[field] = v;
  }
  return out;
}

/** What still launches a custom agent: the roles bound to it and the saved
 *  fan-out presets with a row on it. */
export interface CustomAgentUsers {
  roles: string[];
  presets: string[];
  /** Those of them that pin a model, which goes after the agent's model flag. */
  modelPins: string[];
}

export function customAgentUsers(
  stem: string,
  bindings: OrchestratorRoleBindings,
  presets: readonly FanoutPreset[],
): CustomAgentUsers {
  // Case-insensitive, as findCustomAgent matches a stem.
  const names = (agent: string | undefined) => agent?.toLowerCase() === stem;
  const roles = Object.keys(bindings).filter((role) => names(bindings[role]?.agent));
  const usedBy = presets.filter((p) => p.items.some((it) => names(it.agent)));
  return {
    roles,
    presets: usedBy.map((p) => p.name),
    modelPins: [
      ...roles.filter((role) => !!bindings[role]?.model),
      ...usedBy.filter((p) => p.items.some((it) => names(it.agent) && !!it.model)).map((p) => p.name),
    ],
  };
}

export function isCustomAgentUsed(users: CustomAgentUsers): boolean {
  return users.roles.length > 0 || users.presets.length > 0;
}

/**
 * Validate a draft against the saved list. `editIndex` is the slot being
 * replaced (null for a new agent appended at the end, so the list keeps its
 * order). `usersOf` says what launches a stem: an agent in use keeps its
 * Command's name, since a new one would leave its roles and presets pointing
 * at nothing.
 */
export function applyCustomAgentDraft(
  agents: readonly CustomAgent[],
  draft: CustomAgentDraft,
  editIndex: number | null,
  usersOf: (stem: string) => CustomAgentUsers,
  /** The pane platform (electronAPI.platform), for the path rule. */
  platform?: string,
): { ok: true; next: CustomAgent[] } | { ok: false; issue: CustomAgentIssue } {
  const payload = customAgentDraftPayload(draft);
  const raw: unknown[] = editIndex === null
    ? [...agents, payload]
    : agents.map((a, k) => (k === editIndex ? payload : a));
  const v = validateCustomAgents(raw, { platform });
  if (!v.ok) return { ok: false, issue: { code: v.code, params: v.params, error: v.error } };
  if (editIndex !== null) {
    const before = agents[editIndex];
    const stem = before ? customAgentStem(before) : '';
    const users = usersOf(stem);
    if (before && isCustomAgentUsed(users) && customAgentStem(v.agents[editIndex]) !== stem) {
      const by = [...users.roles, ...users.presets].join(', ');
      return { ok: false, issue: { code: 'agent-in-use', params: { stem, by }, error: `"${stem}" is still used by ${by}` } };
    }
    // A pinned model goes after the model flag: changing or removing it would
    // leave those pins with nothing to follow.
    if (before && users.modelPins.length > 0 && (before.modelFlag ?? '') !== (v.agents[editIndex].modelFlag ?? '')) {
      const by = users.modelPins.join(', ');
      return { ok: false, issue: { code: 'model-in-use', params: { stem, by }, error: `"${stem}" has a model pinned by ${by}; its model flag cannot change` } };
    }
  }
  return { ok: true, next: v.agents };
}
