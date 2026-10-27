import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitOrigin } from '../../../shared/commitOrigin';
import { COMMIT_ORIGINS_FILE, COMMIT_ORIGIN_MAX, COMMIT_ORIGIN_RETENTION_MS, CommitOriginStore } from '../CommitOriginStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-commit-origins-'));
  dirs.push(d);
  return d;
}
const sha = (n: number) => n.toString(16).padStart(40, '0');
const origin = (n: number, at: number): CommitOrigin => ({ sha: sha(n), at, op: 'commit', branch: 'main', evidence: 'only-pane', candidates: [{ ptyId: 'p1', workspaceId: 'ws', agent: 'claude', agentSessionId: 's1' }] });

describe('CommitOriginStore', () => {
  it('keeps the first record of a SHA across a restart, looked up in any case', () => {
    const d = dir();
    const now = Date.now();
    const store = new CommitOriginStore(d, () => now);
    store.add(origin(1, now));
    store.add({ ...origin(1, now), evidence: 'none' });
    store.flushSync();
    const again = new CommitOriginStore(d, () => now);
    expect(again.get(sha(1).toUpperCase())).toEqual(origin(1, now));
    expect(again.get(sha(2))).toBeNull();
  });

  it('drops the oldest past the cap and anything past retention', () => {
    const d = dir();
    const now = Date.now();
    const store = new CommitOriginStore(d, () => now);
    store.add(origin(0, now - COMMIT_ORIGIN_RETENTION_MS - 1));
    expect(store.get(sha(0))).toBeNull();
    for (let k = 1; k <= COMMIT_ORIGIN_MAX + 1; k++) store.add(origin(k, now - COMMIT_ORIGIN_MAX + k));
    expect(store.get(sha(1))).toBeNull();
    expect(store.get(sha(COMMIT_ORIGIN_MAX + 1))).not.toBeNull();
  });

  it('starts empty on a file of another shape, moving it aside, or on one that does not parse', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, COMMIT_ORIGINS_FILE), JSON.stringify({ version: 99, origins: [] }));
    expect(new CommitOriginStore(d).get(sha(1))).toBeNull();
    expect(fs.existsSync(path.join(d, COMMIT_ORIGINS_FILE))).toBe(false); // moved aside
    fs.writeFileSync(path.join(d, COMMIT_ORIGINS_FILE), '{ not json');
    const store = new CommitOriginStore(d);
    expect(store.get(sha(1))).toBeNull();
    store.add(origin(1, Date.now()));
    store.flushSync();
    expect(new CommitOriginStore(d).get(sha(1))).not.toBeNull();
  });
});
