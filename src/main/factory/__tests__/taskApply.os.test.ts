// Apply to my checkout: a bot task's changes written into the bot's
// repository folder, unstaged, from main's records only — on real git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { applyTaskToCheckout, parseRawDiff, type TaskApplyPorts } from '../taskApply';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

const BOT = 'bot-0000000a';
const TASK = 'wtask-abc-12345678';
const BRANCH = 'wtask/perf-a';

let dir: string;
let repo: string;
let wt: string;
let base: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function row(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status: 'review_requested', rev: 3, updatedAt: 1_000, updatedBy: { kind: 'worker', workspaceId: 'ws-task' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', baseOid: base, gitCommonDir: fs.realpathSync.native(path.join(repo, '.git')) },
    ...over,
  };
}

function ports(over: Partial<TaskApplyPorts> = {}): TaskApplyPorts {
  return {
    row: (id) => (id === TASK ? row() : null),
    botRepoPath: () => repo,
    taskBranch: async () => BRANCH,
    noHooksDir: path.join(dir, 'no-hooks'),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'w-apply-')));
  repo = path.join(dir, 'repo');
  wt = path.join(dir, 'wt');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b.txt', 'b\n');
  write(repo, 'gone.txt', 'gone\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  base = git(repo, 'rev-parse', 'HEAD');
  // The worker's worktree, on its task branch: edits a.txt, adds new/n.txt,
  // removes gone.txt.
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  write(wt, 'a.txt', 'a from the task\n');
  write(wt, 'new/n.txt', 'new\n');
  fs.rmSync(path.join(wt, 'gone.txt'));
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'task');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('applyTaskToCheckout', () => {
  it('writes exactly the changed files, removes the removed ones, unstaged, and leaves HEAD and the branch', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    // An unrelated uncommitted change does not stop it.
    write(repo, 'b.txt', 'b, the owner\'s edit\n');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toEqual({ ok: true, changed: ['a.txt'], created: ['new/n.txt'], removed: ['gone.txt'] });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a from the task\n');
    expect(fs.readFileSync(path.join(repo, 'new/n.txt'), 'utf8')).toBe('new\n');
    expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('b, the owner\'s edit\n');
    // Nothing staged; HEAD and the branch did not move.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status.split('\n').filter(Boolean).sort()).toEqual([' D gone.txt', ' M a.txt', ' M b.txt', '?? new/n.txt']);
  });

  it('refuses when a path the task changed has uncommitted changes, lists it, and writes nothing', async () => {
    write(repo, 'a.txt', 'the owner\'s own edit\n');
    write(repo, 'new/n.txt', 'an untracked file of the owner\'s\n');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toMatchObject({ ok: false, code: 'dirty' });
    expect(r.ok ? [] : [...(r.paths ?? [])].sort()).toEqual(['a.txt', 'new/n.txt']);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('the owner\'s own edit\n');
    expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(true);
  });

  it('refuses an unknown task, a malformed id and a task that is not a bot\'s', async () => {
    expect(await applyTaskToCheckout(ports(), 'wtask-nope-00000000')).toMatchObject({ ok: false, code: 'unknown_task' });
    expect(await applyTaskToCheckout(ports(), '../etc')).toMatchObject({ ok: false, code: 'invalid_argument' });
    const notBot = ports({ row: () => row({ dispatch: { origin: { kind: 'pane' }, baseOid: base } }) });
    expect(await applyTaskToCheckout(notBot, TASK)).toMatchObject({ ok: false, code: 'unknown_task' });
  });

  it('refuses a head that does not come from the task\'s base', async () => {
    // A base the task branch does not descend from.
    git(repo, 'checkout', '-q', '-b', 'side');
    write(repo, 'side.txt', 'side\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'side');
    const side = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    const r = await applyTaskToCheckout(ports({ row: () => row({ dispatch: { ...(row().dispatch as NonNullable<LedgerEntry['dispatch']>), baseOid: side } }) }), TASK);
    expect(r).toMatchObject({ ok: false, code: 'foreign_head' });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('refuses a checkout in the middle of a merge', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), `${base}\n`);
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'merge_in_progress' });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('refuses a bot with no repository folder, and a folder that is another repository', async () => {
    expect(await applyTaskToCheckout(ports({ botRepoPath: () => undefined }), TASK)).toMatchObject({ ok: false, code: 'no_repo' });
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-q', repo, other);
    expect(await applyTaskToCheckout(ports({ botRepoPath: () => other }), TASK)).toMatchObject({ ok: false, code: 'other_repo' });
  });

  it('refuses a task still at work, and a repository config that runs a program on a read', async () => {
    expect(await applyTaskToCheckout(ports({ row: () => row({ status: 'working' }) }), TASK)).toMatchObject({ ok: false, code: 'not_ready' });
    git(repo, 'config', 'filter.x.smudge', 'touch pwned');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'config_refused' });
  });
});

describe('factoryTaskApplyHandler', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('answers the main window\'s top frame only; any other sender writes nothing', async () => {
    const { factoryTaskApplyHandler } = await import('../../ipc/handlers/factory.handler');
    const row = vi.fn(() => null);
    const h = factoryTaskApplyHandler(() => win, () => ports({ row }));
    expect(await h({ sender: {}, senderFrame: mainFrame }, { taskId: TASK })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await h({ sender: webContents, senderFrame: { id: 'sub' } }, { taskId: TASK })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(row).not.toHaveBeenCalled();
    expect(await h({ sender: webContents, senderFrame: mainFrame }, { taskId: 'nope' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const ok = await h({ sender: webContents, senderFrame: mainFrame }, { taskId: TASK });
    expect(row).toHaveBeenCalledWith(TASK);
    expect(ok).toMatchObject({ ok: false, code: 'unknown_task' });
  });
});

describe('parseRawDiff', () => {
  it('reads each entry\'s modes, status and path', () => {
    const z = ':100644 100644 aaaa bbbb M\0a b.txt\0:000000 160000 0000 cccc A\0sub\0';
    expect(parseRawDiff(z)).toEqual([
      { srcMode: '100644', dstMode: '100644', status: 'M', path: 'a b.txt' },
      { srcMode: '000000', dstMode: '160000', status: 'A', path: 'sub' },
    ]);
  });
});
