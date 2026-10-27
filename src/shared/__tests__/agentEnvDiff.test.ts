import { describe, expect, it } from 'vitest';
import { diffAgentEnvs, type AgentEnvHost } from '../agentEnvDiff';
import { buildAgentEnvSummary, parseAgentEnvSummary, type AgentEnvSummary } from '../agentEnvSummary';
import type { ProviderInventory, SurfaceItem } from '../tokenUsage/surfaceTypes';

const LF = 'a'.repeat(64);
const CRLF = 'b'.repeat(64);

function skill(name: string, extra: Partial<SurfaceItem> = {}): SurfaceItem {
  return {
    id: `claude:skill::${name}`, provider: 'claude', kind: 'skill', name, parent: null, source: 'user',
    enabled: true, effect: 'none', toggleable: true, readOnlyReason: null, hookEvent: null, hookCost: null,
    descriptionChars: 10, originPath: `/Users/someone/.claude/skills/${name}`, settingsPath: '/Users/someone/.claude/settings.json', ...extra,
  } as SurfaceItem;
}

function inventory(items: SurfaceItem[], cliVersion: string | null = '2.1.0'): ProviderInventory {
  return { provider: 'claude', cliVersion, versionSupported: true, writable: true, items, warnings: [], scannedAtMs: 0 } as ProviderInventory;
}

function summary(over: { version?: string | null; skills?: string[]; hash?: string | null } = {}): AgentEnvSummary {
  return buildAgentEnvSummary({
    wmuxVersion: '4.4.0',
    inventories: [inventory((over.skills ?? ['review']).map((n) => skill(n)), over.version === undefined ? '2.1.0' : over.version)],
    versions: [{ agent: 'gemini', version: null }],
    instructions: [{ file: '~/.claude/CLAUDE.md', sha256: over.hash === undefined ? LF : over.hash }],
  });
}

const host = (hostId: string, s: AgentEnvSummary | null, status: AgentEnvHost['status'] = 'ok'): AgentEnvHost => ({ hostId, name: hostId, status, summary: s });

describe('agent env summary', () => {
  it('keeps names, versions and hashes only: no paths, no settings files', () => {
    const s = summary();
    expect(s.skills).toEqual([{ agent: 'claude', name: 'review', source: 'user' }]);
    expect(JSON.stringify(s)).not.toMatch(/\/Users\/|settings\.json/);
    expect(parseAgentEnvSummary({ ...s, schema: 2 })).toBeNull();
    expect(parseAgentEnvSummary({ ...s, instructions: [{ file: '~/../etc/passwd', sha256: LF }] })?.instructions).toEqual([]);
  });
});

describe('diffAgentEnvs', () => {
  it('reports nothing for PCs that match', () => {
    expect(diffAgentEnvs([host('local', summary()), host('h1', summary())]).rows).toEqual([]);
  });

  it('shows a version, a missing skill and a line-ending difference, and lists a PC that could not answer', () => {
    const diff = diffAgentEnvs([
      host('local', summary()),
      host('h1', summary({ version: '2.0.9', skills: ['review', 'ship'], hash: CRLF })),
      host('h2', null, 'unsupported'),
    ]);
    expect(diff.compared).toEqual(['local', 'h1']);
    expect(diff.skipped).toEqual([{ hostId: 'h2', status: 'unsupported' }]);
    expect(diff.rows).toEqual([
      { kind: 'agent', name: 'claude', values: { local: '2.1.0', h1: '2.0.9' } },
      { kind: 'instruction', name: '~/.claude/CLAUDE.md', values: { local: LF, h1: CRLF } },
      { kind: 'skill', agent: 'claude', name: 'ship', source: 'user', values: { local: null, h1: 'on' } },
    ]);
  });

  it('a skill turned off differs from one turned on; an unread agent\'s items are unknown, not missing', () => {
    const off = buildAgentEnvSummary({
      wmuxVersion: '4.4.0',
      inventories: [inventory([skill('review', { enabled: false })])],
      versions: [{ agent: 'gemini', version: null }],
      instructions: [{ file: '~/.claude/CLAUDE.md', sha256: LF }],
    });
    expect(diffAgentEnvs([host('local', summary()), host('h1', off)]).rows)
      .toEqual([{ kind: 'skill', agent: 'claude', name: 'review', source: 'user', values: { local: 'on', h1: 'off' } }]);
    // Unread: no claude agent row and no claude skills, only the incomplete mark.
    const read = summary({ skills: [] });
    const unread = { ...read, agents: read.agents.filter((a) => a.agent !== 'claude'), incomplete: ['claude'] };
    expect(diffAgentEnvs([host('local', summary()), host('h1', unread)]).rows).toEqual([]);
    // Another build that checks one more file: not "missing" on this PC.
    const newer = { ...summary(), instructions: [...summary().instructions, { file: '~/.cursor/rules.md', sha256: LF }] };
    expect(diffAgentEnvs([host('local', summary()), host('h1', newer)]).rows).toEqual([]);
  });
});

describe('a summary from another PC', () => {
  const base = { schema: 1, wmuxVersion: '4.4.0', instructions: [], mcpServers: [] };

  it('reads a present but invalid version as unknown, and only an absent one as not installed', () => {
    const s = parseAgentEnvSummary({ ...base, skills: [], agents: [{ agent: 'claude', version: 'v\u200b2' }, { agent: 'codex', version: 7 }, { agent: 'gemini', version: null }, { agent: 'qwen' }] });
    expect(s?.agents).toEqual([
      { agent: 'claude', version: 'unknown' }, { agent: 'codex', version: 'unknown' },
      { agent: 'gemini', version: null }, { agent: 'qwen', version: null },
    ]);
  });

  it('a list with a dropped row, or no list, is not fully read: what it lacks is not reported missing', () => {
    const dropped = parseAgentEnvSummary({ ...base, agents: [], skills: [{ agent: 'claude', name: 'review', source: 'user' }, { agent: 'claude', name: 'x', source: 'nowhere' }] });
    expect(dropped?.skills.map((i) => i.name)).toEqual(['review']);
    expect(dropped?.truncated).toEqual(['skills']);
    const missing = parseAgentEnvSummary({ ...base, agents: [], skills: 'not a list' });
    expect(missing?.truncated).toEqual(['skills']);
    const full = summary({ skills: ['review', 'deploy'] });
    const diff = diffAgentEnvs([host('a', full), host('b', dropped)]);
    expect(diff.rows.find((r) => r.kind === 'skill' && r.name === 'deploy')).toBeUndefined();
  });
});

describe('agent env summary bounds', () => {
  it('drops names with invisible or direction-changing characters, and stays inside its byte budget', () => {
    const s = buildAgentEnvSummary({
      wmuxVersion: '4.4.0',
      inventories: [inventory([skill('review\u200b'), skill('re\u202eview'), ...Array.from({ length: 300 }, (_, i) => skill(`스킬-${i}-${'가'.repeat(100)}`))])],
      versions: [],
      instructions: [],
    });
    expect(s.skills.some((i) => /[\u200b\u202e]/.test(i.name))).toBe(false);
    expect(s.truncated).toEqual(['skills']);
    expect(parseAgentEnvSummary({ ...s, skills: [{ agent: 'claude', name: 're\u00adview', source: 'user' }, { agent: 'claude', name: 'review\u2028', source: 'user' }] })?.skills).toEqual([]);
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(96 * 1024);
  });
});
