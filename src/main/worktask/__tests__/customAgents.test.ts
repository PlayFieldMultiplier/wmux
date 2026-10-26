import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCustomAgentsPath, loadCustomAgentsReport, saveCustomAgents } from '../customAgents';
import { customAgentUsers, getFanoutPresetsPath, loadFanoutPresetsReport } from '../fanoutPresets';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-custom-agents-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// "Tern" and "Gull" are made-up CLIs.
const tern = { name: 'Tern', command: 'tern' };
const gull = { name: 'Gull', command: 'gull' };

describe('custom agent store', () => {
  it('a preset row may name a saved custom agent, and the agent cannot be removed while it does', async () => {
    expect(await saveCustomAgents([tern, gull], new Map(), dir)).toMatchObject({ ok: true });
    fs.writeFileSync(
      getFanoutPresetsPath(dir),
      JSON.stringify({ presets: [{ name: 'Birds', items: [{ agent: 'tern' }, { agent: 'claude' }], worktree: true }] }),
      'utf8',
    );
    expect(loadFanoutPresetsReport(dir).presets.map((p) => p.name)).toEqual(['Birds']);
    const users = customAgentUsers({}, dir);
    expect([...users]).toEqual([['tern', { users: ['the Birds preset'], modelPins: [], unattendedPins: [] }]]);

    const refused = await saveCustomAgents([gull], users, dir);
    expect(refused).toMatchObject({ ok: false, code: 'agent-in-use', params: { stem: 'tern', by: 'the Birds preset' } });
    expect(loadCustomAgentsReport(dir).agents.map((a) => a.name)).toEqual(['Tern', 'Gull']);
    // An agent nothing uses can go.
    expect(await saveCustomAgents([tern], users, dir)).toMatchObject({ ok: true });
  });

  it('counts roles bound to an agent, and keeps the model flag while a role or preset pins a model', async () => {
    const withFlag = { ...tern, modelFlag: '--llm' };
    expect(await saveCustomAgents([withFlag], new Map(), dir)).toMatchObject({ ok: true });
    fs.writeFileSync(
      getFanoutPresetsPath(dir),
      JSON.stringify({ presets: [{ name: 'Birds', items: [{ agent: 'Tern', model: 'm1' }], worktree: true }] }),
      'utf8',
    );
    const users = customAgentUsers({ Builder: { agent: 'tern' } }, dir);
    expect([...users]).toEqual([['tern', { users: ['the Builder role', 'the Birds preset'], modelPins: ['the Birds preset'], unattendedPins: [] }]]);
    expect(await saveCustomAgents([{ ...withFlag, modelFlag: '-M' }], users, dir))
      .toMatchObject({ ok: false, code: 'model-in-use', params: { stem: 'tern', by: 'the Birds preset' } });
    expect(await saveCustomAgents([tern], users, dir)).toMatchObject({ ok: false, code: 'model-in-use' });
    // A preset running it unattended keeps its unattended flags.
    const auto = { ...withFlag, unattendedFlags: '--auto' };
    expect(await saveCustomAgents([auto], users, dir)).toMatchObject({ ok: true });
    fs.writeFileSync(
      getFanoutPresetsPath(dir),
      JSON.stringify({ presets: [{ name: 'Birds', items: [{ agent: 'tern', model: 'm1', unattended: true }], worktree: true }] }),
      'utf8',
    );
    const autoUsers = customAgentUsers({}, dir);
    expect(autoUsers.get('tern')?.unattendedPins).toEqual(['the Birds preset']);
    expect(await saveCustomAgents([withFlag], autoUsers, dir)).toMatchObject({ ok: false, code: 'unattended-in-use' });
    expect(await saveCustomAgents([{ ...auto, unattendedFlags: '--yolo' }], autoUsers, dir)).toMatchObject({ ok: false, code: 'unattended-in-use' });
    // The same flag, other fields changed: fine.
    expect(await saveCustomAgents([{ ...auto, args: '--fast' }], autoUsers, dir)).toMatchObject({ ok: true });
    // A role alone keeps the agent from being removed.
    expect(await saveCustomAgents([], customAgentUsers({ Builder: { agent: 'tern' } }, dir), dir))
      .toMatchObject({ ok: false, code: 'agent-in-use', params: { by: 'the Builder role, the Birds preset' } });
  });

  it('a corrupt file is no custom agents, and a preset row naming one is dropped, not launched', () => {
    fs.writeFileSync(getCustomAgentsPath(dir), '{ nope', 'utf8');
    fs.writeFileSync(
      getFanoutPresetsPath(dir),
      JSON.stringify({ presets: [{ name: 'Birds', items: [{ agent: 'tern' }], worktree: true }] }),
      'utf8',
    );
    expect(loadCustomAgentsReport(dir)).toEqual({ agents: [], dropped: [], unreadable: true });
    const presets = loadFanoutPresetsReport(dir);
    expect(presets.presets).toEqual([]);
    expect(presets.dropped[0]).toMatchObject({ name: 'Birds', issue: { code: 'agent-unknown' } });
  });
});
