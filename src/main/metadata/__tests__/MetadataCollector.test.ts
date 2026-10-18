import { describe, it, expect, vi } from 'vitest';
import {
  MetadataCollector,
  GIT_BRANCH_HIT_TTL_MS,
  GIT_BRANCH_MISS_TTL_MS,
  GIT_BRANCH_CACHE_MAX,
} from '../MetadataCollector';

function make(answers: Record<string, string | undefined>) {
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

  it('forget() drops a directory so the next call asks git again', async () => {
    const f = make({ '/home/u': undefined });
    await f.c.getGitBranch('/home/u');
    f.c.forget('/home/u');
    await f.c.getGitBranch('/home/u');
    expect(f.exec).toHaveBeenCalledTimes(2);
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
