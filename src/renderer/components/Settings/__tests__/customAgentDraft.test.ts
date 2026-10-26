import { describe, expect, it } from 'vitest';
import { applyCustomAgentDraft, customAgentUsers, draftFromCustomAgent } from '../customAgentDraft';
import type { CustomAgent } from '../../../../shared/customAgents';

// Made-up CLIs.
const agents: CustomAgent[] = [
  { name: 'Tern', command: 'tern' },
  { name: 'Gull', command: 'gull', unattendedFlags: '--auto' },
];
const unused = () => ({ roles: [], presets: [] });

describe('applyCustomAgentDraft', () => {
  it('saves an edit in place, so the list keeps its order', () => {
    const r = applyCustomAgentDraft(agents, { ...draftFromCustomAgent(agents[0]), args: '--fast' }, 0, unused);
    expect(r).toEqual({ ok: true, next: [{ name: 'Tern', command: 'tern', args: '--fast' }, agents[1]] });
  });

  it('refuses a new command name for an agent a role or preset still launches', () => {
    const users = customAgentUsers('tern', { Builder: { agent: 'tern' }, Reviewer: { agent: 'codex' } }, [
      { name: 'Birds', items: [{ agent: 'tern' }], worktree: true },
    ]);
    expect(users).toEqual({ roles: ['Builder'], presets: ['Birds'] });
    const r = applyCustomAgentDraft(agents, { ...draftFromCustomAgent(agents[0]), command: 'tern2' }, 0, () => users);
    expect(r).toMatchObject({ ok: false, issue: { code: 'agent-in-use', params: { stem: 'tern', by: 'Builder, Birds' } } });
  });
});
