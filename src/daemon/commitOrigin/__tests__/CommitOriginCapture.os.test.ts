import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommitOrigin } from '../../../shared/commitOrigin';
import { ChildProbeReader } from '../../../main/pty/shareReader';
import { CommitOriginCapture } from '../CommitOriginCapture';

const dirs: string[] = [];
const captures: CommitOriginCapture[] = [];
const readers: ChildProbeReader[] = [];
afterEach(() => {
  for (const c of captures.splice(0)) c.dispose();
  for (const r of readers.splice(0)) r.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** git with no user or system config: an empty global config file (Windows
 *  git cannot open the null device as one). */
function gitIn(globalConfig: string) {
  return (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

describe('CommitOriginCapture (a real repository)', () => {
  it('picks up a commit from the worktree reflog, from the first commit on, and nothing before', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-commit-origin-'));
    dirs.push(repo);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-commit-origin-config-'));
    dirs.push(configDir);
    const globalConfig = path.join(configDir, 'gitconfig');
    fs.writeFileSync(globalConfig, '');
    const git = gitIn(globalConfig);
    git(repo, 'init', '-q');
    const added: CommitOrigin[] = [];
    const armed: string[] = [];
    let text = '';
    // The daemon's reader process, tail included.
    const reader = new ChildProbeReader(5_000);
    readers.push(reader);
    const capture = new CommitOriginCapture({
      store: { add: (o) => { added.push(o); } },
      read: (probe) => reader.read(probe),
      livePanes: () => ['p1'],
      paneText: async () => text,
      pane: (id) => ({ ptyId: id, workspaceId: 'ws-1', agent: null, agentSessionId: null }),
      taskOf: () => null,
      // fs.watch as the capture arms it, noting each armed directory.
      watch: (dir, onChange) => {
        try {
          const w = fs.watch(dir, { persistent: false }, (_e, f) => onChange(f === null ? null : String(f)));
          w.on('error', () => w.close());
          armed.push(dir);
          return w;
        } catch {
          return null;
        }
      },
    });
    captures.push(capture);
    capture.sync([{ sessionId: 'p1', gitDir: path.join(repo, '.git'), branch: 'main' }]);
    // No logs/ before the first commit: the git dir itself is watched for it.
    await vi.waitFor(() => expect(armed).toEqual([path.join(repo, '.git')]), { timeout: 5_000 });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', 'a.txt');
    text = git(repo, 'commit', '-q', '-m', 'first', '--no-verify') || `[main ${git(repo, 'rev-parse', '--short', 'HEAD').trim()}] first`;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    await vi.waitFor(() => expect(added).toHaveLength(1), { timeout: 8_000 });
    expect(added[0]).toMatchObject({ sha: head, op: 'initial', evidence: 'screen', attributed: { ptyId: 'p1' } });
    git(repo, 'commit', '-q', '--amend', '-m', 'first again', '--no-verify');
    const amended = git(repo, 'rev-parse', 'HEAD').trim();
    await vi.waitFor(() => expect(added).toHaveLength(2), { timeout: 8_000 });
    expect(added[1]).toMatchObject({ sha: amended, op: 'amend', evidence: 'only-pane' });
    expect(JSON.stringify(added)).not.toContain('first again');
  }, 20_000);
});
