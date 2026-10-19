// diff:scanRepos (#2438) — a workspace folder that is not a repo but holds
// repos in its subfolders. Against real folders and real git: what is found,
// what is skipped, and that the walk stays bounded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

// Pass-throughs, so a test can count folder reads and git calls, or make the
// access check refuse a path.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git')>();
  return { ...actual, git: vi.fn(actual.git) };
});
vi.mock('../../ipc/handlers/fs.handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ipc/handlers/fs.handler')>();
  return { ...actual, resolveAccessiblePath: vi.fn(actual.resolveAccessiblePath) };
});

import { readdir } from 'node:fs/promises';
import { git } from '../git';
import { resolveAccessiblePath } from '../../ipc/handlers/fs.handler';
import { registerDiffHandlers } from '../../ipc/handlers/diff.handler';
import { IPC } from '../../../shared/constants';
import { scanRepos, SCAN_MAX_DIRS, SCAN_MAX_REPOS } from '../scanRepos';

vi.setConfig({ testTimeout: 30_000 });

let root: string;

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
}

/** The toplevel git reports for `dir`, as the handler answers it. */
function top(dir: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
}

const scan = async (p: unknown) => captured.get(IPC.DIFF_SCAN_REPOS)!({}, p) as Promise<{ ok: true; repoPaths: string[] } | { ok: false }>;

beforeEach(() => {
  vi.mocked(readdir).mockClear();
  vi.mocked(git).mockClear();
  captured.clear();
  registerDiffHandlers();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-scanrepos-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('diff:scanRepos', () => {
  it('lists the repos one and two levels below a folder that is not a repo', async () => {
    initRepo(join(root, 'frontend'));
    initRepo(join(root, 'services', 'billing'));
    initRepo(join(root, 'services', 'auth'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'README.md'), 'x');
    const r = await scan(root);
    expect(r).toEqual({
      ok: true,
      repoPaths: [top(join(root, 'frontend')), top(join(root, 'services', 'auth')), top(join(root, 'services', 'billing'))].sort((a, b) => a.localeCompare(b)),
    });
  });

  it('does not go deeper than two levels, into a repo, or into hidden and dependency folders', async () => {
    initRepo(join(root, 'a', 'b', 'too-deep'));
    initRepo(join(root, 'app'));
    initRepo(join(root, 'app', 'packages', 'nested')); // the outer repo's own
    initRepo(join(root, '.cache', 'hidden'));
    initRepo(join(root, 'node_modules', 'dep'));
    const r = await scan(root);
    expect(r).toEqual({ ok: true, repoPaths: [top(join(root, 'app'))] });
  });

  it('answers an empty list for a folder with no repos, and ok:false for a bad path', async () => {
    mkdirSync(join(root, 'empty'));
    expect(await scan(join(root, 'empty'))).toEqual({ ok: true, repoPaths: [] });
    expect(await scan('')).toEqual({ ok: false });
    expect(await scan(42)).toEqual({ ok: false });
    expect(await scan(join(root, 'missing'))).toEqual({ ok: false });
  });

  it('keeps at most SCAN_MAX_REPOS repos', async () => {
    const dirs = Array.from({ length: SCAN_MAX_REPOS + 3 }, (_, i) => join(root, `r${String(i).padStart(3, '0')}`));
    for (const d of dirs) mkdirSync(join(d, '.git'), { recursive: true });
    // A fake resolver: every folder with a .git entry is its own toplevel.
    const found = await scanRepos(root, async (d) => d);
    expect(found).toHaveLength(SCAN_MAX_REPOS);
  });

  it('reads each folder once and at most SCAN_MAX_DIRS folders in all', async () => {
    for (let i = 0; i < 1000; i++) mkdirSync(join(root, `d${String(i).padStart(4, '0')}`));
    expect(await scanRepos(root, async (d) => d)).toEqual([]);
    const reads = vi.mocked(readdir).mock.calls.map((c) => String(c[0]));
    expect(reads.length).toBeLessThanOrEqual(SCAN_MAX_DIRS);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it('neither lists nor probes a folder the access check refuses below an allowed root', async () => {
    initRepo(join(root, 'app'));
    initRepo(join(root, 'secret'));
    initRepo(join(root, 'secret-group', 'inner'));
    const refused = (p: unknown) => String(p).startsWith(join(root, 'secret'));
    const actual = (await vi.importActual<typeof import('../../ipc/handlers/fs.handler')>('../../ipc/handlers/fs.handler')).resolveAccessiblePath;
    vi.mocked(resolveAccessiblePath).mockImplementation(async (p) => (refused(p) ? null : actual(p)));
    try {
      expect(await scan(root)).toEqual({ ok: true, repoPaths: [top(join(root, 'app'))] });
      expect(vi.mocked(resolveAccessiblePath).mock.calls.some(([p]) => refused(p))).toBe(true);
      expect(vi.mocked(readdir).mock.calls.some(([p]) => refused(p))).toBe(false);
      expect(vi.mocked(git).mock.calls.some(([, cwd]) => refused(cwd))).toBe(false);
    } finally {
      vi.mocked(resolveAccessiblePath).mockImplementation(actual);
    }
  });

  it('refuses the home folder when home is reached through a link', async () => {
    const realHome = join(root, 'home');
    initRepo(join(realHome, 'project'));
    const link = join(root, 'home-link');
    symlinkSync(realHome, link, 'junction');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = link;
    process.env.USERPROFILE = link;
    try {
      expect(await scan(realHome)).toEqual({ ok: true, repoPaths: [] });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
