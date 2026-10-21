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

const FULL = 'abc1234'.padEnd(40, '0');
const BASE = 'b'.repeat(40);

describe('gitShow', () => {
  it('refuses a bad rev or path before running git', async () => {
    for (const input of [{ rev: '--output=x', path: 'README.md' }, { rev: SHA, path: '../x' }, { rev: SHA, path: '.env' }, { rev: SHA, path: '/etc/hosts' }]) {
      const { run } = fakeGit([]);
      expect(await gitShow(ROOT, input, run)).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('resolves the rev once and reads the file at that commit, with a fixed argv', async () => {
    const { run, calls } = fakeGit([
      [`rev-parse --verify --quiet ${SHA}^{commit}`, { stdout: `${FULL}\n` }],
      [`cat-file -t ${FULL}:docs/a.md`, { stdout: 'blob\n' }],
      [`cat-file -s ${FULL}:docs/a.md`, { stdout: '5\n' }],
      [`cat-file blob ${FULL}:docs/a.md`, { stdout: '# Hi\n' }],
    ]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'docs/a.md' }, run)).toEqual({ ok: true, text: `${SHA}:docs/a.md at ${FULL} (5 bytes)\n# Hi\n` });
    expect(calls.filter((c) => c[0] === 'rev-parse')).toHaveLength(1);
    expect(calls.slice(1).every((c) => c[0] === 'cat-file' && c[c.length - 1].startsWith(`${FULL}:`))).toBe(true);
  });

  it('a folder lists its entries without the protected ones', async () => {
    const { run } = fakeGit([
      [`rev-parse --verify --quiet ${SHA}^{commit}`, { stdout: FULL }],
      [`cat-file -t ${FULL}:cfg`, { stdout: 'tree\n' }],
      [`ls-tree --name-only -z ${FULL}:cfg`, { stdout: 'app.json\0.env\0id_rsa\0' }],
    ]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'cfg' }, run)).toEqual({ ok: true, text: `${SHA}:cfg at ${FULL} (folder)\napp.json` });
  });

  it('a commit not in the object store says so', async () => {
    const { run } = fakeGit([]);
    expect(await gitShow(ROOT, { rev: SHA, path: 'README.md' }, run)).toMatchObject({ ok: false, reason: expect.stringContaining('not a commit in this repository') });
  });

  it('caps the output', async () => {
    const big = 'x'.repeat(BOT_REPO_GIT_OUTPUT_MAX + 500);
    const { run } = fakeGit([
      [`rev-parse --verify --quiet ${SHA}^{commit}`, { stdout: FULL }],
      [`cat-file -t ${FULL}:big.txt`, { stdout: 'blob' }],
      [`cat-file -s ${FULL}:big.txt`, { stdout: String(big.length) }],
      [`cat-file blob ${FULL}:big.txt`, { stdout: big }],
    ]);
    const r = await gitShow(ROOT, { rev: SHA, path: 'big.txt' }, run);
    expect(r.ok && r.text.length).toBeLessThan(BOT_REPO_GIT_OUTPUT_MAX + 200);
    expect(r.ok && r.text.endsWith(`[output cut at ${BOT_REPO_GIT_OUTPUT_MAX} characters]`)).toBe(true);
  });
});

describe('gitDiff', () => {
  const RANGE = `${BASE}...${FULL}`;
  const both = (extra: Array<[string, { code?: number; stdout?: string }]>) => fakeGit([
    ['rev-parse --verify --quiet origin/main^{commit}', { stdout: BASE }],
    [`rev-parse --verify --quiet ${SHA}^{commit}`, { stdout: FULL }],
    ...extra,
  ]);
  const FLAGS = 'diff --no-color --no-ext-diff --no-textconv --no-renames --submodule=short';

  it('refuses bad revs and paths before running git', async () => {
    for (const input of [{ base: '-x', head: SHA }, { base: 'origin/main', head: 'a..b' }, { base: 'origin/main', head: SHA, paths: ['../etc'] }, { base: 'origin/main', head: SHA, paths: 'docs' }]) {
      const { run } = fakeGit([]);
      expect(await gitDiff(ROOT, input, run)).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('resolves each rev once; both runs read the same two commits; protected files stay out of the patch', async () => {
    const { run, calls } = both([
      [`${FLAGS} --name-status`, { stdout: 'A\0docs/a.md\0M\0.env\0' }],
      [`${FLAGS} ${RANGE}`, { stdout: '+# a\n' }],
    ]);
    const r = await gitDiff(ROOT, { base: 'origin/main', head: SHA }, run);
    expect(r).toEqual({ ok: true, text: `origin/main...${SHA} (${RANGE}): 2 files changed\nA\tdocs/a.md\nM\t.env  (protected: not shown)\n\n+# a\n` });
    expect(calls.filter((c) => c[0] === 'rev-parse')).toHaveLength(2);
    const diffs = calls.filter((c) => c[0] === 'diff');
    expect(diffs).toHaveLength(2);
    for (const d of diffs) expect(d).toContain(RANGE);
    expect(diffs[1]).toEqual(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', RANGE, '--', '.', ':(exclude,literal).env']);
  });

  it('a ref that moves between the name-status run and the patch run changes nothing', async () => {
    const MOVED = 'f'.repeat(40);
    let resolved = 0;
    const calls: string[][] = [];
    const run: GitRead = async (args) => {
      calls.push(args);
      const line = args.join(' ');
      if (line.startsWith('rev-parse --verify --quiet origin/main^{commit}')) return { code: 0, stdout: resolved++ === 0 ? BASE : MOVED, stderr: '' };
      if (line.startsWith(`rev-parse --verify --quiet ${SHA}^{commit}`)) return { code: 0, stdout: FULL, stderr: '' };
      if (line.includes('--name-status')) {
        // origin/main moves now: a second resolution would see MOVED.
        resolved++;
        return { code: 0, stdout: 'M\0a.md\0', stderr: '' };
      }
      return { code: 0, stdout: '+a\n', stderr: '' };
    };
    expect(await gitDiff(ROOT, { base: 'origin/main', head: SHA }, run)).toMatchObject({ ok: true });
    const diffs = calls.filter((c) => c[0] === 'diff');
    expect(diffs).toHaveLength(2);
    for (const d of diffs) {
      expect(d).toContain(`${BASE}...${FULL}`);
      expect(d.join(' ')).not.toContain(MOVED);
      expect(d.join(' ')).not.toContain('origin/main');
    }
  });

  it('paths are literal pathspecs', async () => {
    const { calls, run } = both([['diff', { stdout: 'M\0docs/a.md\0' }]]);
    await gitDiff(ROOT, { base: 'origin/main', head: SHA, paths: ['docs/*'] }, run);
    expect(calls[2].slice(-2)).toEqual(['--', ':(literal)docs/*']);
  });

  it('caps the patch', async () => {
    const { run } = both([
      [`${FLAGS} --name-status`, { stdout: 'M\0a.md\0' }],
      [`${FLAGS} ${RANGE}`, { stdout: '+'.repeat(BOT_REPO_GIT_OUTPUT_MAX * 2) }],
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
