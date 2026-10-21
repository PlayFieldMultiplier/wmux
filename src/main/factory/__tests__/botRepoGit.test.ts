// git_show / git_diff: what a bot may ask git for in its repository, and
// what comes back. git itself is injected; the argv main would run is what
// is asserted.
import { describe, expect, it, vi } from 'vitest';
import {
  BOT_REPO_GIT_OUTPUT_MAX,
  botRepoGitToolName,
  BOT_REPO_GIT_TOOLS,
  gitDiff,
  gitShow,
  isBotRepoGitTool,
  pathRefusal,
  revRefusal,
  type GitRead,
} from '../botRepoGit';

const ROOT = '/repo';
const SHA = 'abc1234';

/** A git that answers by argv prefix; every call is recorded. */
function fakeGit(answers: Array<[string, { code?: number; stdout?: string; stderr?: string }]>) {
  const calls: string[][] = [];
  const run: GitRead = vi.fn(async (args: string[]) => {
    calls.push(args);
    const line = args.join(' ');
    const hit = answers.find(([prefix]) => line.startsWith(prefix));
    return { code: hit?.[1].code ?? (hit ? 0 : 1), stdout: hit?.[1].stdout ?? '', stderr: hit?.[1].stderr ?? 'not answered' };
  });
  return { run, calls };
}

describe('revs and paths', () => {
  it('takes a 7-40 hex SHA or a plain ref name', () => {
    for (const rev of ['abc1234', 'a'.repeat(40), 'main', 'origin/main', 'wtask/fix-docs-1', 'refs/heads/x', 'v1.2.3']) expect(revRefusal(rev), rev).toBeNull();
  });

  it('refuses options, ranges, rev suffixes and anything else', () => {
    for (const rev of ['', '-rf', '--output=/tmp/x', '-p', 'main..dev', 'a...b', 'HEAD^', 'HEAD~1', 'x@{1}', 'a:b', 'a b', 'a//b', 'a/', 'a.', 'x.lock', '.hidden', 'a\nb', 42, undefined]) {
      expect(revRefusal(rev), String(rev)).not.toBeNull();
    }
  });

  it('takes a relative path inside the repository, never a protected file', () => {
    for (const p of ['README.md', 'docs/guide.html', 'src/a b.ts']) expect(pathRefusal(p), p).toBeNull();
    for (const p of ['', '../x', 'docs/../../etc/passwd', '/etc/passwd', '~/x', 'C:/x', 'a\\b', '-foo', ':(top)x', './x', 'a//b', 'a/', '.env', 'config/.env.local', 'keys/id_rsa', 'server.pem', '.git/config', 'a\0b']) {
      expect(pathRefusal(p), p).not.toBeNull();
    }
  });
});

describe('gitShow', () => {
  it('refuses a bad rev or path before running git', async () => {
    for (const input of [{ rev: '--output=x', path: 'README.md' }, { rev: SHA, path: '../x' }, { rev: SHA, path: '.env' }, { rev: SHA, path: '/etc/hosts' }]) {
      const { run } = fakeGit([]);
      expect(await gitShow(ROOT, input, run)).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('reads a file at a commit with a fixed argv', async () => {
    const { run, calls } = fakeGit([
      [`cat-file -e ${SHA}^{commit}`, {}],
      [`cat-file -t ${SHA}:docs/a.md`, { stdout: 'blob\n' }],
      [`cat-file -s ${SHA}:docs/a.md`, { stdout: '5\n' }],
      [`cat-file blob ${SHA}:docs/a.md`, { stdout: '# Hi\n' }],
    ]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'docs/a.md' }, run)).toEqual({ ok: true, text: `${SHA}:docs/a.md (5 bytes)\n# Hi\n` });
    expect(calls.every((c) => c[0] === 'cat-file')).toBe(true);
  });

  it('a folder lists its entries without the protected ones', async () => {
    const { run } = fakeGit([
      [`cat-file -e ${SHA}^{commit}`, {}],
      [`cat-file -t ${SHA}:cfg`, { stdout: 'tree\n' }],
      [`ls-tree --name-only -z ${SHA}:cfg`, { stdout: 'app.json\0.env\0id_rsa\0' }],
    ]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'cfg' }, run)).toEqual({ ok: true, text: `${SHA}:cfg (folder)\napp.json` });
  });

  it('a commit not in the object store says so', async () => {
    const { run } = fakeGit([]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'README.md' }, run)).toMatchObject({ ok: false, reason: expect.stringContaining('not a commit in this repository') });
  });

  it('caps the output', async () => {
    const big = 'x'.repeat(BOT_REPO_GIT_OUTPUT_MAX + 500);
    const { run } = fakeGit([
      [`cat-file -e ${SHA}^{commit}`, {}],
      [`cat-file -t ${SHA}:big.txt`, { stdout: 'blob' }],
      [`cat-file -s ${SHA}:big.txt`, { stdout: String(big.length) }],
      [`cat-file blob ${SHA}:big.txt`, { stdout: big }],
    ]);
    const r = await gitShow(ROOT, { rev: SHA, path: 'big.txt' }, run);
    expect(r.ok && r.text.length).toBeLessThan(BOT_REPO_GIT_OUTPUT_MAX + 200);
    expect(r.ok && r.text.endsWith(`[output cut at ${BOT_REPO_GIT_OUTPUT_MAX} characters]`)).toBe(true);
  });
});

describe('gitDiff', () => {
  const both = (extra: Array<[string, { code?: number; stdout?: string }]>) => fakeGit([
    ['cat-file -e origin/main^{commit}', {}],
    [`cat-file -e ${SHA}^{commit}`, {}],
    ...extra,
  ]);

  it('refuses bad revs and paths before running git', async () => {
    for (const input of [{ base: '-x', head: SHA }, { base: 'origin/main', head: 'a..b' }, { base: 'origin/main', head: SHA, paths: ['../etc'] }, { base: 'origin/main', head: SHA, paths: 'docs' }]) {
      const { run } = fakeGit([]);
      expect(await gitDiff(ROOT, input, run)).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('names every changed file and leaves protected ones out of the patch', async () => {
    const { run, calls } = both([
      ['diff --no-color --no-ext-diff --no-textconv --no-renames --submodule=short --name-status', { stdout: 'A\0docs/a.md\0M\0.env\0' }],
      ['diff --no-color --no-ext-diff --no-textconv --no-renames --submodule=short origin/main', { stdout: '+# a\n' }],
    ]);
    const r = await gitDiff(ROOT, { base: 'origin/main', head: SHA }, run);
    expect(r).toEqual({ ok: true, text: `origin/main...${SHA}: 2 files changed\nA\tdocs/a.md\nM\t.env  (protected: not shown)\n\n+# a\n` });
    expect(calls[calls.length - 1]).toEqual(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', `origin/main...${SHA}`, '--', '.', ':(exclude,literal).env']);
  });

  it('paths are literal pathspecs', async () => {
    const { calls, run } = both([['diff', { stdout: 'M\0docs/a.md\0' }]]);
    await gitDiff(ROOT, { base: 'origin/main', head: SHA, paths: ['docs/*'] }, run);
    expect(calls[2].slice(-2)).toEqual(['--', ':(literal)docs/*']);
  });

  it('caps the patch', async () => {
    const { run } = both([
      ['diff --no-color --no-ext-diff --no-textconv --no-renames --submodule=short --name-status', { stdout: 'M\0a.md\0' }],
      ['diff --no-color --no-ext-diff --no-textconv --no-renames --submodule=short origin/main', { stdout: '+'.repeat(BOT_REPO_GIT_OUTPUT_MAX * 2) }],
    ]);
    const r = await gitDiff(ROOT, { base: 'origin/main', head: SHA }, run);
    expect(r.ok && r.text.endsWith(`[output cut at ${BOT_REPO_GIT_OUTPUT_MAX} characters]`)).toBe(true);
  });
});

describe('the session names', () => {
  it('are not wmux MCP tools, so the guest gate (mcp__wmux__ only) refuses them in a tainted wake', () => {
    for (const t of BOT_REPO_GIT_TOOLS) {
      expect(botRepoGitToolName(t).startsWith('mcp__wmux__')).toBe(false);
      expect(isBotRepoGitTool(botRepoGitToolName(t))).toBe(true);
    }
    expect(isBotRepoGitTool('mcp__wmux__git_show')).toBe(false);
  });
});
