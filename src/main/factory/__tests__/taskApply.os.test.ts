// Apply to my checkout: a bot task's changes written into the bot's
// repository folder, unstaged, from main's records only — on real git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { applyTaskToCheckout, defaultRawGit, filteredPaths, isDivergedApply, lineEndingArgs, modesApplied, parseRawDiff, patchHasGitlink, patchPaths, privateGitInitArgs, repoObjectFormat, type TaskApplyPorts, type TaskApplyRawGit } from '../taskApply';

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
    scratchDir: path.join(dir, 'wmux', 'factory', 'apply'),
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
    const racing: TaskApplyRawGit = async (args, cwd, env, input) => {
      if (args.includes('apply') && !args.includes('--check')) {
        fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=evil\nm.txt filter=x=y\n');
        const attrs = path.join(dir, 'attrs');
        fs.writeFileSync(attrs, '* filter=evil\n');
        execFileSync('git', ['config', 'core.attributesFile', attrs], { cwd: repo });
        execFileSync('git', ['config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
        execFileSync('git', ['config', 'filter.x=y.smudge', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
      }
      return defaultRawGit(args, cwd, env, input);
    };
    const r = await applyTaskToCheckout(ports({ gitRaw: racing }), TASK);
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

describe('where and how git apply runs', () => {
  it('its private git dir is under main\'s own folder (0700), the patch comes on stdin, and git speaks C', async () => {
    const seen: Array<{ gitDir: string; mode: number; input: number; lc?: string; args: string[] }> = [];
    const spy: TaskApplyRawGit = async (args, cwd, env, input) => {
      const gd = args.find((a) => a.startsWith('--git-dir='))?.slice(10) ?? '';
      if (args.includes('apply')) seen.push({ gitDir: gd, mode: fs.statSync(path.dirname(gd)).mode & 0o777, input: input?.length ?? 0, lc: env.LC_ALL, args });
      return defaultRawGit(args, cwd, env, input);
    };
    const scratch = path.join(dir, 'wmux', 'factory', 'apply');
    expect(await applyTaskToCheckout(ports({ gitRaw: spy }), TASK)).toMatchObject({ ok: true });
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(path.relative(scratch, call.gitDir).startsWith('..')).toBe(false);
      if (process.platform !== 'win32') expect(call.mode).toBe(0o700);
      expect(call.input).toBeGreaterThan(0);
      expect(call.lc).toBe('C');
      // No patch file named on the command line.
      expect(call.args.some((a) => a.endsWith('.patch'))).toBe(false);
    }
    // Nothing is left behind.
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('the owner\'s line endings in the repository\'s info/attributes still hold for the task\'s files', async () => {
    write(wt, 'run.bat', 'echo hi\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'bat');
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.bat text eol=crlf\n');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'run.bat'), 'utf8')).toBe('echo hi\r\n');
  });

  it.skipIf(process.platform === 'win32')('a task that only makes a file executable is applied, not taken for already applied', async () => {
    git(wt, 'reset', '-q', '--hard', base);
    fs.chmodSync(path.join(wt, 'b.txt'), 0o755);
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-qm', 'chmod');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true, changed: ['b.txt'] });
    expect(fs.statSync(path.join(repo, 'b.txt')).mode & 0o111).not.toBe(0);
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'no_changes' });
  });

  it('a task that only makes a file executable, in a checkout that does not track the bit, says there is nothing to write', async () => {
    git(repo, 'config', 'core.filemode', 'false');
    git(wt, 'reset', '-q', '--hard', base);
    // The bit set in the task's commit itself, whatever the platform.
    git(wt, 'update-index', '--chmod=+x', 'b.txt');
    git(wt, 'commit', '-qm', 'chmod');
    expect(await applyTaskToCheckout(ports(), TASK)).toEqual({ ok: false, code: 'no_changes', message: 'Nothing to write: this checkout does not track the executable bit.' });
  });

  it('refuses a task that changes a .gitattributes', async () => {
    write(wt, 'sub/.gitattributes', '*.txt text\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'attrs');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'filtered', paths: ['sub/.gitattributes'] });
  });

  it('a cleanup that fails does not turn a landed apply into an error', async () => {
    const rm = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('busy'); });
    try {
      expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true });
    } finally {
      rm.mockRestore();
    }
  });

  it('applies in a sha256 repository', async () => {
    const r2 = path.join(dir, 'r256');
    const w2 = path.join(dir, 'w256');
    fs.mkdirSync(r2);
    try {
      git(r2, 'init', '-q', '-b', 'main', '--object-format=sha256');
    } catch {
      return; // this git has no sha256
    }
    git(r2, 'config', 'core.autocrlf', 'false');
    write(r2, 'a.txt', 'a\n');
    git(r2, 'add', '.');
    git(r2, 'commit', '-qm', 'base');
    const b2 = git(r2, 'rev-parse', 'HEAD');
    git(r2, 'worktree', 'add', '-q', '-b', BRANCH, w2);
    write(w2, 'a.txt', 'a from the task\n');
    git(w2, 'commit', '-qam', 'task');
    const p2 = ports({
      row: () => row({ dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', baseOid: b2, gitCommonDir: fs.realpathSync.native(path.join(r2, '.git')) } }),
      botRepoPath: () => r2,
    });
    expect(await applyTaskToCheckout(p2, TASK)).toMatchObject({ ok: true, changed: ['a.txt'] });
    expect(fs.readFileSync(path.join(r2, 'a.txt'), 'utf8')).toBe('a from the task\n');
  });

  it('a filter the shared config gains after the check never runs when the dirty check re-hashes a file', async () => {
    const marker = path.join(dir, 'pwned-clean').replace(/\\/g, '/');
    const attrs = path.join(dir, 'attrs2');
    const realGit: NonNullable<TaskApplyPorts['git']> = (await import('../../worktask/taskPush')).defaultGit;
    // The last read of the shared repository (its HEAD): from here on, a
    // worker's config and attributes would apply to anything main ran there.
    const racing: NonNullable<TaskApplyPorts['git']> = async (args, cwd, env, opts) => {
      const r = await realGit(args, cwd, env, opts);
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        fs.writeFileSync(attrs, '* filter=evil\n');
        execFileSync('git', ['config', 'core.attributesFile', attrs], { cwd: repo });
        execFileSync('git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
        // Stat data that no longer matches the index: git re-hashes the file.
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(path.join(repo, 'a.txt'), later, later);
      }
      return r;
    };
    expect(await applyTaskToCheckout(ports({ git: racing }), TASK)).toMatchObject({ ok: true });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('attributes planted in the shared info/attributes before the copy name a driver that does not exist there: refused, nothing runs', async () => {
    const marker = path.join(dir, 'pwned-planted').replace(/\\/g, '/');
    const realGit: NonNullable<TaskApplyPorts['git']> = (await import('../../worktask/taskPush')).defaultGit;
    const racing: NonNullable<TaskApplyPorts['git']> = async (args, cwd, env, opts) => {
      const r = await realGit(args, cwd, env, opts);
      if (args.includes('HEAD') && args.includes('rev-parse')) {
        fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
        execFileSync('git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
        execFileSync('git', ['config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
      }
      return r;
    };
    expect(await applyTaskToCheckout(ports({ git: racing }), TASK)).toMatchObject({ ok: false, code: 'filtered' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('applies a task that turns a file into a link', async () => {
    git(wt, 'reset', '-q', '--hard', base);
    fs.rmSync(path.join(wt, 'b.txt'));
    fs.symlinkSync('a.txt', path.join(wt, 'b.txt'));
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'link');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true, changed: ['b.txt'] });
    expect(fs.lstatSync(path.join(repo, 'b.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(repo, 'b.txt'))).toBe('a.txt');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'no_changes' });
  });

  it('refuses a partial clone: git would fetch a missing object from its promisor remote', async () => {
    git(repo, 'config', 'remote.origin.promisor', 'true');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'config_refused' });
  });

  it('refuses a .gitattributes in any letter case', async () => {
    write(wt, 'sub/.GitAttributes', '*.txt text\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'attrs');
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: false, code: 'filtered', paths: ['sub/.GitAttributes'] });
  });

  it.skipIf(process.platform === 'win32')('a FIFO in place of info/attributes neither hangs Apply nor is read', async () => {
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    execFileSync('mkfifo', [path.join(repo, '.git', 'info', 'attributes')]);
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true });
  });

  it('removes a folder a crashed Apply left behind', async () => {
    const scratch = path.join(dir, 'wmux', 'factory', 'apply');
    const left = path.join(scratch, 'apply-left');
    fs.mkdirSync(left, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(left, old, old);
    expect(await applyTaskToCheckout(ports(), TASK)).toMatchObject({ ok: true });
    expect(fs.existsSync(left)).toBe(false);
  });

  it('git reads a large stdin to its end, or stops early, without an error escaping', async () => {
    const r = await defaultRawGit(['version'], dir, {}, Buffer.alloc(8 * 1024 * 1024, 0x61));
    expect(r.code).toBe(0);
    expect(r.stdout.toString('utf8')).toMatch(/^git version/);
  });

  it('applies in a shallow (depth 1) checkout', async () => {
    write(repo, 'a.txt', 'a, second commit\n');
    git(repo, 'commit', '-qam', 'second');
    const sh = path.join(dir, 'shallow');
    git(dir, 'clone', '-q', '--depth', '1', `file://${repo.replace(/\\/g, '/')}`, sh);
    git(sh, 'config', 'core.autocrlf', 'false');
    expect(fs.existsSync(path.join(sh, '.git', 'shallow'))).toBe(true);
    const shBase = git(sh, 'rev-parse', 'HEAD');
    const shWt = path.join(dir, 'shallow-wt');
    git(sh, 'worktree', 'add', '-q', '-b', BRANCH, shWt);
    write(shWt, 'new.txt', 'new in a shallow task\n');
    git(shWt, 'add', '-A');
    git(shWt, 'commit', '-qm', 'task');
    const p2 = ports({
      row: () => row({ dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', baseOid: shBase, gitCommonDir: fs.realpathSync.native(path.join(sh, '.git')) } }),
      botRepoPath: () => sh,
    });
    expect(await applyTaskToCheckout(p2, TASK)).toMatchObject({ ok: true, created: ['new.txt'] });
    expect(fs.readFileSync(path.join(sh, 'new.txt'), 'utf8')).toBe('new in a shallow task\n');
  });

  it('git\'s own GIT_DEFAULT_HASH in the owner\'s environment does not change the private git dir of a sha1 repository', async () => {
    const realGit: NonNullable<TaskApplyPorts['git']> = (await import('../../worktask/taskPush')).defaultGit;
    // The owner's environment says sha256; what main sets wins.
    const ownerEnv = { GIT_DEFAULT_HASH: 'sha256' };
    const p2 = ports({
      git: (args, cwd, env, opts) => realGit(args, cwd, { ...ownerEnv, ...env }, opts),
      gitRaw: (args, cwd, env, input) => defaultRawGit(args, cwd, { ...ownerEnv, ...env }, input),
    });
    expect(await applyTaskToCheckout(p2, TASK)).toMatchObject({ ok: true });
  });

  it('the owner\'s global attributes file holds for the task\'s files', async () => {
    const attrs = path.join(dir, 'owner-attributes');
    fs.writeFileSync(attrs, '*.txt eol=crlf\n');
    const globalConfig = path.join(dir, 'owner-gitconfig');
    fs.writeFileSync(globalConfig, `[core]\n\tattributesFile = ${attrs.replace(/\\/g, '/')}\n`);
    const realGit: NonNullable<TaskApplyPorts['git']> = (await import('../../worktask/taskPush')).defaultGit;
    // The owner's global config; the private git dir's own empty one wins there.
    const ownerEnv = { GIT_CONFIG_GLOBAL: globalConfig };
    const p2 = ports({
      git: (args, cwd, env, opts) => realGit(args, cwd, { ...ownerEnv, ...env }, opts),
      gitRaw: (args, cwd, env, input) => defaultRawGit(args, cwd, { ...ownerEnv, ...env }, input),
    });
    expect(await applyTaskToCheckout(p2, TASK)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'new/n.txt'), 'utf8')).toBe('new\r\n');
  });

  it('a git stopped by a signal, or one that never started, is no answer: merge-base reports git_failed, not foreign_head', async () => {
    const stopped = await defaultRawGit(['-c', 'alias.hang=!sleep 30', 'hang'], dir, {}, undefined, 200);
    expect(stopped.code).toBe(128);
    expect(stopped.stderr).toMatch(/stopped/);
    const missing = await defaultRawGit(['version'], path.join(dir, 'no-such-folder'), {});
    expect(missing.code).toBe(128);
    const failing: TaskApplyRawGit = async (args, cwd, env, input) => (args.includes('merge-base') ? { code: 128, stdout: Buffer.alloc(0), stderr: 'git was stopped (SIGTERM)' } : defaultRawGit(args, cwd, env, input));
    expect(await applyTaskToCheckout(ports({ gitRaw: failing }), TASK)).toMatchObject({ ok: false, code: 'git_failed' });
  });

  it('a stopped git is settled when its tree is gone, though an orphan it left still holds the pipes', async () => {
    // `( … &)` orphans the first sleep at once, so no tree walk from git reaches
    // it; it keeps git's pipes open for 20 s (in `/`, never the test's folder).
    // The second sleep keeps git running until the 300 ms stop.
    const start = Date.now();
    const stopped = await defaultRawGit(['-c', 'alias.orphan=!(cd / && sleep 20 &); sleep 20', 'orphan'], dir, {}, undefined, 300);
    expect(stopped.code).toBe(128);
    expect(stopped.stderr).toMatch(/stopped/);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('a git that exited before the stop is settled by the stop, without waiting on pipes an orphan holds', async () => {
    // git exits at once; its orphaned child holds the pipes for 20 s, so
    // 'close' is late, and the 300 ms timer fires between 'exit' and 'close'.
    const start = Date.now();
    const late = await defaultRawGit(['-c', 'alias.bg=!(cd / && sleep 20 &)', 'bg'], dir, {}, undefined, 300);
    expect(late.code).toBe(128);
    expect(late.stderr).toMatch(/stopped/);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('stopping a git stops what it started too: a shell alias\'s child does not outlive the stop', async () => {
    // The alias's child writes a marker after 3 s; stopped at 200 ms, it must never get there.
    const marker = path.join(dir, 'outlived.txt');
    const stopped = await defaultRawGit(['-c', `alias.slow=!sleep 3 && echo late > '${marker.replace(/\\/g, '/')}'`, 'slow'], dir, {}, undefined, 200);
    expect(stopped.code).toBe(128);
    await deliberateSleep(4000, 'a negative check: the alias child, had it survived, writes its marker at 3 s');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a git apply --numstat that fails is reported as it is, not as a changed history', async () => {
    const failing: TaskApplyRawGit = async (args, cwd, env, input) => (args.includes('--numstat') ? { code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: something else' } : defaultRawGit(args, cwd, env, input));
    expect(await applyTaskToCheckout(ports({ gitRaw: failing }), TASK)).toEqual({ ok: false, code: 'git_failed', message: 'git apply --numstat failed: fatal: something else' });
    // A real mismatch still says so.
    const other: TaskApplyRawGit = async (args, cwd, env, input) => (args.includes('--numstat') ? { code: 0, stdout: Buffer.from('1\t0\tsomewhere/else.txt\0'), stderr: '' } : defaultRawGit(args, cwd, env, input));
    expect(await applyTaskToCheckout(ports({ gitRaw: other }), TASK)).toMatchObject({ ok: false, code: 'git_failed', message: 'The task\'s history changed while it was read; try again.' });
  });

  it('an index whose times cannot be kept is refused without naming main\'s folder', async () => {
    const utimes = vi.spyOn(fs, 'utimesSync').mockImplementationOnce(() => { throw new Error(`EPERM: ${path.join(dir, 'wmux', 'factory', 'apply')}`); });
    try {
      const r = await applyTaskToCheckout(ports(), TASK);
      expect(r).toEqual({ ok: false, code: 'git_failed', message: 'Your checkout\'s index could not be read.' });
    } finally {
      utimes.mockRestore();
    }
  });

  it('reads the object format from the repository\'s own config only', () => {
    expect(repoObjectFormat([{ scope: 'global', key: 'extensions.objectformat', value: 'sha256' }])).toBe('sha1');
    expect(repoObjectFormat([{ scope: 'local', key: 'extensions.objectformat', value: 'SHA256' }])).toBe('sha256');
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
    // The owner's own attributes file, never one the repository names.
    expect(lineEndingArgs([
      { scope: 'system', key: 'core.autocrlf', value: 'true' },
      { scope: 'global', key: 'core.attributesfile', value: '~/.gitattributes' },
      { scope: 'local', key: 'core.attributesfile', value: '/tmp/evil' },
    ])).toEqual(['-c', 'core.autocrlf=true', '-c', 'core.attributesFile=~/.gitattributes']);
  });
});

describe('the patch read back', () => {
  it('reads the paths git apply --numstat -z names, and finds a gitlink in its headers', () => {
    expect(patchPaths('1\t1\ta.txt\0-\t-\tbin/x.png\0' + '2\t0\tdir/with\ttab.txt\0')).toEqual(['a.txt', 'bin/x.png', 'dir/with\ttab.txt']);
    expect(patchHasGitlink(Buffer.from('diff --git a/s b/s\nnew file mode 160000\nindex 0000000..abc\n'))).toBe(true);
    expect(patchHasGitlink(Buffer.from('diff --git a/s b/s\nindex abc..def 160000\n'))).toBe(true);
    expect(patchHasGitlink(Buffer.from('diff --git a/a b/a\nindex abc..def 100644\n+160000\n'))).toBe(false);
  });

  it('reads modes only where the checkout keeps them', () => {
    const exec = [{ status: 'A', srcMode: '000000', dstMode: '100755', path: 'b.txt' }];
    // b.txt in the fixture is not executable.
    expect(modesApplied(repo, exec, { fileMode: true, symlinks: true })).toBe(false);
    expect(modesApplied(repo, exec, { fileMode: false, symlinks: true })).toBe(true);
    const link = [{ status: 'T', srcMode: '100644', dstMode: '120000', path: 'b.txt' }];
    expect(modesApplied(repo, link, { fileMode: true, symlinks: true })).toBe(false);
    expect(modesApplied(repo, link, { fileMode: true, symlinks: false })).toBe(true);
  });
});

describe('parseRawDiff', () => {
  it('reads each entry\'s modes, status and path', () => {
    const z = ':100644 100644 aaaa bbbb M\0a b.txt\0:000000 160000 0000 cccc A\0sub\0';
    expect(parseRawDiff(z)).toEqual([
      { srcMode: '100644', dstMode: '100644', srcOid: 'aaaa', dstOid: 'bbbb', status: 'M', path: 'a b.txt' },
      { srcMode: '000000', dstMode: '160000', srcOid: '0000', dstOid: 'cccc', status: 'A', path: 'sub' },
    ]);
  });
});
