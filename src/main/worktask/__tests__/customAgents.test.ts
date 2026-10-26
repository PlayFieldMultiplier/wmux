import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCustomAgentsPath, loadCustomAgentsReport, saveCustomAgents } from '../customAgents';
import { customAgentPresetUsers, getFanoutPresetsPath, loadFanoutPresetsReport } from '../fanoutPresets';

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
    const users = customAgentPresetUsers(dir);
    expect([...users]).toEqual([['tern', ['Birds']]]);

    const refused = await saveCustomAgents([gull], users, dir);
    expect(refused).toMatchObject({ ok: false, code: 'agent-in-use', params: { stem: 'tern', by: 'Birds' } });
    expect(loadCustomAgentsReport(dir).agents.map((a) => a.name)).toEqual(['Tern', 'Gull']);
    // An agent nothing uses can go.
    expect(await saveCustomAgents([tern], users, dir)).toMatchObject({ ok: true });
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
