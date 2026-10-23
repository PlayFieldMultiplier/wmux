import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAWN_POLICY,
  SPAWN_CLOCK_SKEW_MS,
  SPAWN_TTL_MAX_MS,
  coerceSpawnPolicy,
  defaultSpawnPolicy,
  normalizeSpawnSub,
  parseSpawnRequest,
  parseSpawnResult,
  spawnClockOk,
  spawnTargetsFor,
} from '../a2aSpawn';

const HOST = '11111111-1111-4111-8111-111111111111';
const ID = 'sp-0b7c2f6a-1d3e-4f5a-9b8c-7d6e5f4a3b2c';

const request = (over: Record<string, unknown> = {}) => ({
  v: 1, spawnId: ID, agent: 'claude', folder: { root: 'web', sub: 'apps/site' }, text: 'fix the build',
  expiresAt: '2026-10-24T00:00:00.000Z', from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' }, ...over,
});

describe('parseSpawnRequest', () => {
  it('takes exactly the request fields and nothing else', () => {
    expect(parseSpawnRequest(request())).toMatchObject({ spawnId: ID, agent: 'claude', folder: { root: 'web', sub: 'apps/site' } });
    for (const extra of ['env', 'args', 'command', 'cwd', 'permissionMode', 'model', 'images']) {
      expect(parseSpawnRequest(request({ [extra]: 'x' }))).toBeNull();
    }
    expect(parseSpawnRequest(request({ folder: { root: 'web', path: '/etc' } }))).toBeNull();
    expect(parseSpawnRequest(request({ agent: 'bash' }))).toBeNull();
    expect(parseSpawnRequest(request({ spawnId: 'not-a-spawn-id' }))).toBeNull();
    expect(parseSpawnRequest(request({ from: { kind: 'brain', workspaceId: 'ws-a' } }))).toBeNull();
    expect(parseSpawnRequest(request({ text: '   ' }))).toBeNull();
    expect(parseSpawnRequest(request({ text: 'x'.repeat(33 * 1024) }))).toBeNull();
  });
});

describe('normalizeSpawnSub', () => {
  it('keeps a plain relative path and refuses anything that could leave the root', () => {
    expect(normalizeSpawnSub(undefined)).toBe('');
    expect(normalizeSpawnSub('./apps//site/')).toBe('apps/site');
    for (const bad of ['../x', 'a/../../b', '/etc', 'C:/Windows', 'c:x', 'a\\b', '\\\\srv\\share', 'a\u0000b', 'a\nb', 'x'.repeat(513)]) {
      expect(normalizeSpawnSub(bad)).toBeNull();
    }
  });
});

describe('spawnClockOk (B\'s clock)', () => {
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();
  it('refuses a request from the future, one living over 72 h, and an expired one', () => {
    expect(spawnClockOk(at(now - 1000), at(now + 3600_000), now)).toBe(true);
    expect(spawnClockOk(at(now + SPAWN_CLOCK_SKEW_MS + 1000), at(now + 3600_000), now)).toBe(false);
    expect(spawnClockOk(at(now), at(now + SPAWN_TTL_MAX_MS + 1000), now)).toBe(false);
    // Sent long ago with a far expiry: over 72 h from its own send time.
    expect(spawnClockOk(at(now - 48 * 3600_000), at(now + 30 * 3600_000), now)).toBe(false);
    expect(spawnClockOk(at(now - 7200_000), at(now - 1000), now)).toBe(false);
  });
});

describe('parseSpawnResult', () => {
  it('carries a code, and an endpoint only with started', () => {
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'not-allowed' })).toEqual({ v: 1, spawnId: ID, code: 'not-allowed' });
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'not-allowed', message: '/home/x' })).toBeNull();
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'started' })).toBeNull();
    expect(parseSpawnResult({ v: 1, spawnId: ID, code: 'started', endpoint: { kind: 'pane', workspaceId: 'w', paneId: 'p' }, linkVersion: 1 })).not.toBeNull();
  });
});

describe('the policy', () => {
  it('is off by default with nobody allowed, and runs agents in auto mode', () => {
    expect(DEFAULT_SPAWN_POLICY).toMatchObject({ enabled: false, approval: 'ask', followUps: 'ask', permissionMode: 'auto', hosts: {}, roots: [], agents: [] });
    expect(coerceSpawnPolicy(defaultSpawnPolicy())).toEqual(defaultSpawnPolicy());
  });

  it('refuses a policy with anything unknown rather than dropping it', () => {
    const base = { ...defaultSpawnPolicy(), enabled: true };
    expect(coerceSpawnPolicy({ ...base, agents: ['claude', 'rm'] })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, permissionMode: 'yolo' })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, hosts: { 'not-a-host': { allowed: true } } })).toBeNull();
    expect(coerceSpawnPolicy({ ...base, roots: [{ id: 'a', label: 'A', path: '/x' }, { id: 'a', label: 'B', path: '/y' }] })).toBeNull();
  });

  it('tells an allowed PC root ids, labels and agents, never paths', () => {
    const policy = { ...defaultSpawnPolicy(), enabled: true, hosts: { [HOST]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: '/Users/me/web' }], agents: ['claude' as const], version: 4 };
    const targets = spawnTargetsFor(policy, HOST);
    expect(targets).toEqual({ v: 1, version: 4, roots: [{ id: 'web', label: 'Web' }], agents: ['claude'] });
    expect(JSON.stringify(targets)).not.toContain('/Users');
    expect(spawnTargetsFor({ ...policy, enabled: false }, HOST)).toBeNull();
    expect(spawnTargetsFor(policy, '22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});
