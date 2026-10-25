// workspace-repos.json: a workspace's remembered repository or None, kept
// across a restart; a file that cannot be read is never overwritten.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceRepoStore, workspaceReposPath } from '../workspaceRepos';
import { persisterWritesSettled } from '../versionedFile';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfui-wsrepos-'));
});
afterEach(async () => {
  await persisterWritesSettled();
  fs.rmSync(dir, { recursive: true, force: true });
});

const APP = { repoKey: 'github.com/acme/app', repoPath: '/src/app', originPin: 'https://github.com/acme/app.git' };
const open = (): WorkspaceRepoStore => {
  const s = new WorkspaceRepoStore({ file: workspaceReposPath(dir), now: () => Date.parse('2026-10-25T00:00:00Z'), log: () => undefined });
  s.load();
  return s;
};

describe('WorkspaceRepoStore', () => {
  it('remembers a repository or None per workspace, across a restart', async () => {
    const s = open();
    expect(s.get('ws-1')).toBeNull();
    s.setRepo('ws-1', APP);
    s.setNone('ws-2');
    await s.flush();
    const again = open();
    expect(again.get('ws-1')).toEqual({ repo: APP, at: '2026-10-25T00:00:00.000Z' });
    expect(again.get('ws-2')).toEqual({ none: true, at: '2026-10-25T00:00:00.000Z' });
  });

  it('a workspace\'s answer is forgotten on clear, on disk too', async () => {
    const s = open();
    s.setRepo('ws-1', APP);
    s.setNone('ws-2');
    s.clear('ws-1');
    await s.flush();
    const again = open();
    expect(again.get('ws-1')).toBeNull();
    expect(again.get('ws-2')).toMatchObject({ none: true });
  });

  it('None replaces a remembered repository only when asked to (no bot holds it); a repository replaces None', () => {
    const s = open();
    s.setRepo('ws-1', APP);
    s.setNone('ws-1');
    expect(s.get('ws-1')).toMatchObject({ repo: APP });
    s.setNone('ws-1', { replace: true });
    expect(s.get('ws-1')).toMatchObject({ none: true });
    s.setRepo('ws-1', APP);
    s.setNone('ws-2');
    s.setRepo('ws-2', APP);
    expect(s.get('ws-2')).toMatchObject({ repo: APP });
  });

  it('a file of another version or unreadable: nothing remembered, and the file is left as it is', async () => {
    const file = workspaceReposPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 9, workspaces: {} }));
    const s = open();
    s.setRepo('ws-1', APP);
    expect(s.get('ws-1')).toBeNull();
    await s.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 9, workspaces: {} });
  });

  it('drops a malformed entry and keeps the rest', async () => {
    const file = workspaceReposPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces: { 'ws-1': { repo: APP, at: '2026-10-25T00:00:00.000Z' }, 'ws-2': { repo: { repoKey: '' }, at: 'x' } } }));
    const s = open();
    expect(s.get('ws-1')).toMatchObject({ repo: APP });
    expect(s.get('ws-2')).toBeNull();
  });
});
