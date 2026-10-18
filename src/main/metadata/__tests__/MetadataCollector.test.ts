import { describe, it, expect, vi } from 'vitest';
import {
  MetadataCollector,
  GIT_BRANCH_HIT_TTL_MS,
  GIT_BRANCH_MISS_TTL_MS,
  GIT_BRANCH_ERROR_TTL_MS,
  GIT_BRANCH_CACHE_MAX,
  type GitBranchLookup,
} from '../MetadataCollector';

function make(answers: Record<string, GitBranchLookup>) {
  let clock = 0;
  const exec = vi.fn(async (cwd: string) => answers[cwd]);
  const c = new MetadataCollector({ now: () => clock, exec });
  return { c, exec, advance: (ms: number) => { clock += ms; } };
}

describe('MetadataCollector.getGitBranch — per-directory cache', () => {
  it('a non-repo directory is asked once per miss TTL, not once per 5 s poll tick', async () => {
    const f = make({ '/home/u': undefined });
    // Twelve 5 s ticks = one minute of polling on a pane sitting in ~.
    for (let i = 0; i < 12; i++) {
      expect(await f.c.getGitBranch('/home/u')).toBeUndefined();
      f.advance(5_000);
    }
    expect(f.exec).toHaveBeenCalledTimes(1);
    // Past the miss TTL it is asked again (a `git init` since would show).
    f.advance(GIT_BRANCH_MISS_TTL_MS);
    await f.c.getGitBranch('/home/u');
    expect(f.exec).toHaveBeenCalledTimes(2);
  });

  it('a repo directory is re-asked only after the hit TTL', async () => {
    const f = make({ '/repo': 'main' });
    expect(await f.c.getGitBranch('/repo')).toBe('main');
    f.advance(GIT_BRANCH_HIT_TTL_MS - 1);
    expect(await f.c.getGitBranch('/repo')).toBe('main');
    expect(f.exec).toHaveBeenCalledTimes(1);
    f.advance(2);
    expect(await f.c.getGitBranch('/repo')).toBe('main');
    expect(f.exec).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers for one directory share a single spawn', async () => {
    const f = make({ '/repo': 'main' });
    const [a, b, c] = await Promise.all([f.c.getGitBranch('/repo'), f.c.getGitBranch('/repo'), f.c.getGitBranch('/repo')]);
    expect([a, b, c]).toEqual(['main', 'main', 'main']);
    expect(f.exec).toHaveBeenCalledTimes(1);
  });

  it('directories are cached independently', async () => {
    const f = make({ '/repo': 'main', '/home/u': undefined });
    expect(await f.c.getGitBranch('/repo')).toBe('main');
    expect(await f.c.getGitBranch('/home/u')).toBeUndefined();
    expect(await f.c.getGitBranch('/repo')).toBe('main');
    expect(f.exec).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup (null) is held only briefly, never for the not-a-repo minute', async () => {
    const f = make({ '/repo': null });
    expect(await f.c.getGitBranch('/repo')).toBeUndefined();
    f.advance(GIT_BRANCH_ERROR_TTL_MS - 1);
    await f.c.getGitBranch('/repo');
    expect(f.exec).toHaveBeenCalledTimes(1);
    f.advance(2);
    await f.c.getGitBranch('/repo');
    expect(f.exec).toHaveBeenCalledTimes(2);
  });

  it('a rejecting exec is a failed lookup: resolves undefined, does not poison the directory', async () => {
    let clock = 0;
    let calls = 0;
    const c = new MetadataCollector({
      now: () => clock,
      exec: async () => { calls++; if (calls === 1) throw new Error('EBUSY'); return 'main'; },
    });
    await expect(c.getGitBranch('/repo')).resolves.toBeUndefined();
    clock += GIT_BRANCH_ERROR_TTL_MS + 1;
    await expect(c.getGitBranch('/repo')).resolves.toBe('main');
    expect(calls).toBe(2);
  });

  it('an older lookup finishing last cannot overwrite a newer answer', async () => {
    const gates: Array<(v: GitBranchLookup) => void> = [];
    const c = new MetadataCollector({
      now: () => 0,
      exec: () => new Promise<GitBranchLookup>((r) => { gates.push(r); }),
    });
    const first = c.getGitBranch('/repo');
    // The entry is evicted meanwhile (cache pressure), then asked again.
    for (let i = 0; i < GIT_BRANCH_CACHE_MAX; i++) void c.getGitBranch(`/d${i}`);
    const second = c.getGitBranch('/repo');
    // exec is invoked on the microtask queue; let every lookup start.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(gates).toHaveLength(GIT_BRANCH_CACHE_MAX + 2);
    gates[gates.length - 1]?.('new');
    gates[0]?.('old');
    expect(await second).toBe('new');
    expect(await first).toBe('old');
    expect(await c.getGitBranch('/repo')).toBe('new');
  });

  it('the cache is bounded', async () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < GIT_BRANCH_CACHE_MAX + 10; i++) answers[`/d${i}`] = 'b';
    const f = make(answers);
    for (let i = 0; i < GIT_BRANCH_CACHE_MAX + 10; i++) await f.c.getGitBranch(`/d${i}`);
    // The oldest were evicted: asking for /d0 spawns again, /d(last) does not.
    await f.c.getGitBranch('/d0');
    await f.c.getGitBranch(`/d${GIT_BRANCH_CACHE_MAX + 9}`);
    expect(f.exec).toHaveBeenCalledTimes(GIT_BRANCH_CACHE_MAX + 10 + 1);
  });
});
