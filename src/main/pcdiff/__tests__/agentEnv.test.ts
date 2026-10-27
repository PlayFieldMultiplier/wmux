import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedAgentEnvSummary, collectAgentEnvSummary, fetchRemoteAgentEnv, resetAgentEnvCacheForTest, type AgentEnvDeps } from '../agentEnv';
import type { ProviderInventory } from '../../../shared/tokenUsage/surfaceTypes';

const HOME = '/home/someone';

function deps(files: Record<string, string | Buffer>, over: Partial<AgentEnvDeps> = {}): AgentEnvDeps {
  return {
    wmuxVersion: '4.4.0',
    homeDir: HOME,
    readInventory: async (provider) => ({ provider, cliVersion: provider === 'claude' ? '2.1.0' : null, versionSupported: true, writable: false, items: [], warnings: [], scannedAtMs: 0 }) as ProviderInventory,
    resolveCommand: (command) => (command === 'gemini' ? '/opt/npm/bin/gemini' : null),
    realpath: async (p) => (p === '/opt/npm/bin/gemini' ? '/opt/npm/lib/node_modules/@google/gemini-cli/dist/index.js' : p),
    readFile: async (p) => {
      const f = files[p.split(path.sep).join('/')];
      if (f === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.isBuffer(f) ? f : Buffer.from(f);
    },
    ...over,
  };
}

afterEach(() => resetAgentEnvCacheForTest());

describe('collectAgentEnvSummary', () => {
  it('hashes the instruction files byte for byte, and reads gemini\'s version from its package', async () => {
    const files = {
      [`${HOME}/.claude/CLAUDE.md`]: 'rule\n',
      [`${HOME}/.codex/AGENTS.md`]: 'rule\r\n',
      '/opt/npm/lib/node_modules/@google/gemini-cli/package.json': JSON.stringify({ name: '@google/gemini-cli', version: '0.9.1' }),
    };
    const s = await collectAgentEnvSummary(deps(files));
    const hash = (file: string) => s.instructions.find((i) => i.file === file)?.sha256;
    expect(hash('~/.claude/CLAUDE.md')).toMatch(/^[0-9a-f]{64}$/);
    expect(hash('~/.codex/AGENTS.md')).not.toBe(hash('~/.claude/CLAUDE.md')); // CRLF is a real difference
    expect(hash('~/.gemini/GEMINI.md')).toBeNull();
    expect(s.agents).toEqual(expect.arrayContaining([
      { agent: 'claude', version: '2.1.0' },
      { agent: 'gemini', version: '0.9.1' },
      { agent: 'qwen', version: null },
    ]));
    expect(JSON.stringify(s)).not.toContain(HOME);
  });

  it('reads the local summary at most once per minute', async () => {
    let reads = 0;
    const d = deps({}, { readInventory: async (provider) => { reads++; return { provider, cliVersion: null, versionSupported: false, writable: false, items: [], warnings: [], scannedAtMs: 0 } as ProviderInventory; } });
    await cachedAgentEnvSummary(d, 1_000);
    await cachedAgentEnvSummary(d, 30_000);
    expect(reads).toBe(3);
    await cachedAgentEnvSummary(d, 62_000);
    expect(reads).toBe(6);
  });
});

describe('fetchRemoteAgentEnv', () => {
  const host = { origin: 'https://office.example:9600', token: 't' };
  const answer = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

  it('maps a host\'s answer to why it was or was not compared', async () => {
    expect((await fetchRemoteAgentEnv(host, answer(404))).status).toBe('unsupported');
    expect((await fetchRemoteAgentEnv(host, answer(401))).status).toBe('auth-rejected');
    expect((await fetchRemoteAgentEnv(host, answer(503))).status).toBe('unavailable');
    expect((await fetchRemoteAgentEnv(host, async () => { throw new Error('ECONNREFUSED'); })).status).toBe('unreachable');
    expect((await fetchRemoteAgentEnv({ ...host, origin: 'http://office.example:9600' }, answer(200))).status).toBe('unavailable');
    const ok = await fetchRemoteAgentEnv(host, answer(200, { schema: 1, wmuxVersion: '4.4.0', agents: [], skills: [], mcpServers: [], instructions: [] }));
    expect(ok).toMatchObject({ status: 'ok', summary: { wmuxVersion: '4.4.0' } });
  });
});
