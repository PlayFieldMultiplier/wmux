// The Git page's commit / push / PR refuse a change that carries a secret
// file or a key-shaped value — against a real git repository.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { ShipActions } from '../shipActions';

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let dir: string;
let repo: string;
let gh: ReturnType<typeof vi.fn<(args: string[]) => Promise<{ stdout: string }>>>;
let svc: ShipActions;
/** Makes every `git diff` fail, as a broken or overloaded check would. */
let diffFails = false;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ship-secrets-'));
  const remote = path.join(dir, 'remote.git');
  repo = path.join(dir, 'repo');
  git(['init', '-q', '--bare', '-b', 'main', remote], dir);
  git(['clone', '-q', remote, repo], dir);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  git(['push', '-q', 'origin', 'HEAD:main'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);
  git(['checkout', '-q', '-b', 'feat/x'], repo);
  git(['push', '-q', '-u', 'origin', 'feat/x'], repo);
  gh = vi.fn(async (_args: string[]) => ({ stdout: 'https://github.com/o/r/pull/1\n' }));
  const exec = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    if (cmd.startsWith('gh')) return gh(args);
    if (diffFails && args[0] === 'diff') return Promise.reject(new Error('maxBuffer exceeded'));
    try {
      return Promise.resolve({ stdout: execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', maxBuffer: 1 << 24 }) });
    } catch (e) {
      return Promise.reject(e);
    }
  };
  diffFails = false;
  svc = new ShipActions(exec as never, async () => null, () => undefined, () => 1000, () => false);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const pin = () => ({ branch: 'feat/x', head: git(['rev-parse', 'HEAD'], repo) });

describe('ShipActions secret guard', () => {
  it('commit refuses a .env file, leaves nothing staged or committed, and says why', async () => {
    const before = pin().head;
    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    const res = await svc.commit(repo, 'add', pin());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.secrets).toEqual([{ path: '.env', what: 'file', kind: 'env' }]);
    expect(res.error).toContain('.env holds passwords and keys, so it was not committed');
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo)).toBe('');
  });

  it('a refused commit leaves the index exactly as the user staged it', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], repo); // b staged, a modified but unstaged
    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n'); // untracked
    const index = () => [git(['ls-files', '-s'], repo), git(['diff', '--cached', '--name-status'], repo), git(['status', '--porcelain'], repo)];
    const before = index();
    const res = await svc.commit(repo, 'add', pin());
    expect(res).toMatchObject({ ok: false, secrets: [{ path: '.env' }] });
    expect(index()).toEqual(before);
    expect(git(['diff', '--cached', '--name-only'], repo)).toBe('b.txt');
  });

  it('fails closed: when the check cannot run, commit, push and PR are refused with a plain reason', async () => {
    const before = pin().head;
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], repo);
    const staged = git(['ls-files', '-s'], repo);
    diffFails = true;
    const commit = await svc.commit(repo, 'add', pin());
    expect(commit).toMatchObject({ ok: false, secretScanFailed: true });
    expect(!commit.ok && commit.error).toContain('could not check this change for passwords and keys, so it was not committed');
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(git(['ls-files', '-s'], repo)).toBe(staged);
    diffFails = false;
    git(['commit', '-q', '-m', 'b'], repo);
    diffFails = true;
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secretScanFailed: true });
    expect(git(['ls-remote', 'origin', 'feat/x'], repo)).not.toContain(pin().head);
    expect(await svc.createPr(repo, 't', pin())).toMatchObject({ ok: false, secretScanFailed: true });
    expect(gh).not.toHaveBeenCalled();
  });

  it('commit refuses a key-shaped value and never echoes it', async () => {
    const key = `sk-proj-${'A1b2'.repeat(8)}`;
    fs.writeFileSync(path.join(repo, 'cfg.ts'), `export const k = "${key}";\n`);
    const res = await svc.commit(repo, 'add', pin());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.secrets?.[0]).toMatchObject({ path: 'cfg.ts', what: 'value', kind: 'openai', line: 1 });
    expect(res.error).not.toContain(key);
  });

  it('commit lets a .env.example through', async () => {
    fs.writeFileSync(path.join(repo, '.env.example'), 'OPENAI_API_KEY=\n');
    expect(await svc.commit(repo, 'add example', pin())).toEqual({ ok: true });
  });

  it('push and PR refuse a branch whose commits add a secret file; gh is never called', async () => {
    fs.mkdirSync(path.join(repo, 'certs'));
    fs.writeFileSync(path.join(repo, 'certs', 'server.key'), 'k\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'oops'], repo);
    const push = await svc.push(repo, pin());
    expect(push).toMatchObject({ ok: false, secrets: [{ path: 'certs/server.key', what: 'file', kind: 'private-key' }] });
    expect(git(['ls-remote', 'origin', 'feat/x'], repo)).not.toContain(pin().head);
    const pr = await svc.createPr(repo, 'title', pin());
    expect(pr).toMatchObject({ ok: false, secrets: [{ path: 'certs/server.key' }] });
    expect(gh).not.toHaveBeenCalled();
  });

  it('a clean branch still pushes and opens its PR', async () => {
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'b'], repo);
    expect(await svc.push(repo, pin())).toEqual({ ok: true });
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/1' });
  });
});
