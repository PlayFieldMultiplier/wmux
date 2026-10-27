import { describe, expect, it } from 'vitest';
import type { RpcRouter } from '../../RpcRouter';
import type { CommitOrigin } from '../../../../shared/commitOrigin';
import { registerCommitOriginRpc } from '../commitOrigin.rpc';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN: CommitOrigin = { sha: SHA, at: 1, op: 'commit', branch: 'main', evidence: 'none', candidates: [] };

function handler(lookup: (sha: string) => Promise<CommitOrigin | null | 'unavailable'>) {
  let fn: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;
  registerCommitOriginRpc({ register: (_m: string, h: typeof fn) => { fn = h; } } as unknown as RpcRouter, lookup);
  if (!fn) throw new Error('not registered');
  return fn as (params: Record<string, unknown>) => Promise<unknown>;
}

describe('commit.origin', () => {
  it('looks a full SHA up (any case), and says when it is not one or the daemon cannot answer', async () => {
    const asked: string[] = [];
    const call = handler(async (sha) => { asked.push(sha); return sha === SHA ? ORIGIN : null; });
    expect(await call({ sha: SHA.toUpperCase() })).toEqual({ ok: true, origin: ORIGIN });
    expect(await call({ sha: 'f'.repeat(40) })).toEqual({ ok: true, origin: null });
    expect(await call({ sha: SHA.slice(0, 7) })).toEqual({ ok: false, reason: 'invalid' });
    expect(await call({})).toEqual({ ok: false, reason: 'invalid' });
    expect(asked).toEqual([SHA, 'f'.repeat(40)]);
    expect(await handler(async () => 'unavailable')({ sha: SHA })).toEqual({ ok: false, reason: 'unavailable' });
  });
});
