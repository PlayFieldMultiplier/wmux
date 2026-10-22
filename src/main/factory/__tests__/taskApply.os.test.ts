// Apply to my checkout: a bot task's changes written into the bot's
// repository folder, unstaged, from main's records only — on real git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { applyTaskToCheckout, filteredPaths, isDivergedApply, lineEndingArgs, parseRawDiff, privateGitInitArgs, type TaskApplyPorts } from '../taskApply';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

const BOT = 'bot-0000000a';
const TASK = 'wtask-abc-12345678';
const BRANCH = 'wtask/perf-a';

let dir: string;
let repo: string;
let wt: string;
let base: string;

/** Ten lines; `lines(2, 'x')` has line 2 replaced. */
function lines(...edits: Array<[number, string]>): string {
  const out = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  for (const [n, text] of edits) out[n - 1] = text;
  return `${out.join('\n')}\n`;
}

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
  // Files read back byte for byte, whatever the runner's global autocrlf.
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'a.txt', 'a\n');
  write(repo, 'b.txt', 'b\n');
  write(repo, 'gone.txt', 'gone\n');
  write(repo, 'm.txt', lines());
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  base = git(repo, 'rev-parse', 'HEAD');
  // The worker's worktree, on its task branch: edits a.txt and line 2 of
  // m.txt, adds new/n.txt, removes gone.txt.
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  write(wt, 'a.txt', 'a from the task\n');
  write(wt, 'new/n.txt', 'new\n');
  write(wt, 'm.txt', lines([2, 'line 2 from the task']));
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
    expect(r).toEqual({ ok: true, changed: ['a.txt', 'm.txt'], created: ['new/n.txt'], removed: ['gone.txt'] });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a from the task\n');
    expect(fs.readFileSync(path.join(repo, 'new/n.txt'), 'utf8')).toBe('new\n');
    expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('b, the owner\'s edit\n');
    // Nothing staged; HEAD and the branch did not move.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status.split('\n').filter(Boolean).sort()).toEqual([' D gone.txt', ' M a.txt', ' M b.txt', ' M m.txt', '?? new/n.txt']);
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

  it('applies the task\'s patch, not its files: the checkout\'s own commits since the base are kept', async () => {
    // The owner pulled an upstream change to another part of m.txt.
    write(repo, 'm.txt', lines([9, 'line 9 from upstream']));
    git(repo, 'commit', '-qam', 'upstream');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toMatchObject({ ok: true, changed: ['a.txt', 'm.txt'] });
    expect(fs.readFileSync(path.join(repo, 'm.txt'), 'utf8')).toBe(lines([2, 'line 2 from the task'], [9, 'line 9 from upstream']));
  });

  it('refuses a patch that no longer applies (diverged) and writes nothing; says so when the checkout already has it', async () => {
    write(repo, 'm.txt', lines([2, 'line 2 from upstream']));
    git(repo, 'commit', '-qam', 'upstream');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'diverged' });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(fs.existsSync(path.join(repo, 'new/n.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(true);
    // The task merged and pulled: nothing to apply.
    git(repo, 'reset', '-q', '--hard', base);
    git(repo, 'merge', '-q', '--ff-only', BRANCH);
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'no_changes' });
  });

  it('refuses an untracked file standing where a new file\'s folder goes, and lists it', async () => {
    write(repo, 'new', 'a file of the owner\'s\n');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toMatchObject({ ok: false, code: 'dirty', paths: ['new'] });
    expect(fs.readFileSync(path.join(repo, 'new'), 'utf8')).toBe('a file of the owner\'s\n');
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

describe('content filters', () => {
  it('reads the paths check-attr gives a filter driver', () => {
    expect(filteredPaths('a.bin\0filter\0lfs\0b.txt\0filter\0unspecified\0c.txt\0filter\0x=y\0d\0filter\0set\0')).toEqual(['a.bin', 'c.txt']);
  });

  it('a driver the shared repository gains while the apply runs never runs, by info/attributes or a name with "="', async () => {
    // A live worker writes the shared git dir between the checks and the
    // write; simulated by a git wrapper right before the apply.
    const marker = path.join(dir, 'pwned').replace(/\\/g, '/');
    const realGit: NonNullable<TaskApplyPorts['git']> = (await import('../../worktask/taskPush')).defaultGit;
    const racing: NonNullable<TaskApplyPorts['git']> = async (args, cwd, env, opts) => {
      if (args.includes('apply') && !args.includes('--check')) {
        fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=evil\nm.txt filter=x=y\n');
        const attrs = path.join(dir, 'attrs');
        fs.writeFileSync(attrs, '* filter=evil\n');
        execFileSync('git', ['config', 'core.attributesFile', attrs], { cwd: repo });
        execFileSync('git', ['config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
        execFileSync('git', ['config', 'filter.x=y.smudge', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
      }
      return realGit(args, cwd, env, opts);
    };
    const r = await applyTaskToCheckout(ports({ git: racing }), TASK);
    expect(r).toMatchObject({ ok: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'new/n.txt'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(repo, 'm.txt'), 'utf8')).toBe(lines([2, 'line 2 from the task']));
  });

  it('refuses a path the checkout runs through a content filter (Git LFS), and lists it', async () => {
    write(repo, '.gitattributes', 'new/** filter=lfs diff=lfs merge=lfs -text\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-qm', 'lfs');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'filtered', paths: ['new/n.txt'] });
    expect(fs.existsSync(path.join(repo, 'new/n.txt'))).toBe(false);
  });
});

describe('the patch and the owner\'s settings', () => {
  it('a diff or apply setting of the owner\'s does not reshape the patch', async () => {
    git(repo, 'config', 'diff.noprefix', 'true');
    git(repo, 'config', 'diff.mnemonicPrefix', 'true');
    git(repo, 'config', 'apply.whitespace', 'error');
    // A new file in a folder, with trailing whitespace.
    write(wt, 'deep/er/ws.txt', 'trailing   \n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'more');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toMatchObject({ ok: true, created: ['deep/er/ws.txt', 'new/n.txt'] });
    expect(fs.readFileSync(path.join(repo, 'deep/er/ws.txt'), 'utf8')).toBe('trailing   \n');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a from the task\n');
  });

  it('a checkout on autocrlf keeps its CRLF lines', async () => {
    git(repo, 'config', 'core.autocrlf', 'true');
    // The checkout as git wrote it on autocrlf: every line CRLF.
    fs.writeFileSync(path.join(repo, 'm.txt'), lines().replace(/\n/g, '\r\n'));
    // The index as such a checkout records it (the same blob, this file's stat).
    git(repo, 'add', 'm.txt');
    expect(git(repo, 'status', '--porcelain', '--', 'm.txt')).toBe('');
    const r = await applyTaskToCheckout(ports(), TASK);
    expect(r).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'm.txt'), 'utf8')).toBe(lines([2, 'line 2 from the task']).replace(/\n/g, '\r\n'));
  });

  it('a second Apply says the checkout already has the changes', async () => {
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true });
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'no_changes', message: 'Your checkout already has the task\'s changes.' });
  });

  it('only a mismatch is diverged; other apply errors are reported as they are', () => {
    expect(isDivergedApply('error: patch failed: m.txt:1\nerror: m.txt: patch does not apply')).toBe(true);
    expect(isDivergedApply('error: new/n.txt: already exists in working directory')).toBe(true);
    expect(isDivergedApply('error: gone.txt: No such file or directory')).toBe(true);
    expect(isDivergedApply('error: corrupt patch at line 7')).toBe(false);
  });

  it('names the object format to git init only for a sha256 repository (git before 2.29 has no flag)', () => {
    expect(privateGitInitArgs('sha1', '/t/git')).toEqual(['init', '-q', '--bare', '--template=', '/t/git']);
    expect(privateGitInitArgs('sha256', '/t/git')).toEqual(['init', '-q', '--bare', '--template=', '--object-format=sha256', '/t/git']);
  });

  it('passes only the owner\'s line ending settings, last value winning', () => {
    expect(lineEndingArgs([
      { scope: 'global', key: 'core.autocrlf', value: 'input' },
      { scope: 'local', key: 'core.autocrlf', value: 'true' },
      { scope: 'local', key: 'filter.evil.smudge', value: 'x' },
      { scope: 'global', key: 'core.eol', value: 'lf' },
    ])).toEqual(['-c', 'core.autocrlf=true', '-c', 'core.eol=lf']);
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
