// git_show / git_diff against a real repository: a commit made in a worker's
// worktree is readable from the bot's repository root (one object store),
// protected files stay out, and the in-process MCP server answers an MCP
// client the way the bot's SDK session calls it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gitDiff, gitShow } from '../botRepoGit';
import { createBotRepoGitServer } from '../botRepoGitServer';

let tmp = '';
let repo = '';
let head = '';

const run = (args: string[], cwd: string): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-repo-git-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  run(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  run(['add', '-A'], repo);
  run(['commit', '-q', '-m', 'init'], repo);
  // A worker's worktree outside the repository, as TaskWorktreeManager makes them.
  const wt = path.join(tmp, 'worktrees', 'wtask-1');
  run(['worktree', 'add', '-q', '-b', 'wtask/docs-1', wt, 'main'], repo);
  fs.mkdirSync(path.join(wt, 'docs'));
  fs.writeFileSync(path.join(wt, 'docs', 'guide.md'), '# Guide\n\nHello.\n');
  fs.writeFileSync(path.join(wt, '.env'), 'TOKEN=dummy-secret\n');
  run(['add', '-A'], wt);
  run(['commit', '-q', '-m', 'docs: guide'], wt);
  head = run(['rev-parse', 'HEAD'], wt);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('real git', () => {
  it('git_diff reads the worker commit from the repository root, without the protected file', async () => {
    const r = await gitDiff(repo, { base: 'main', head });
    expect(r.ok).toBe(true);
    const text = r.ok ? r.text : '';
    expect(text).toContain(`main...${head}: 2 files changed`);
    expect(text).toContain('A\tdocs/guide.md');
    expect(text).toContain('A\t.env  (protected: not shown)');
    expect(text).toContain('+Hello.');
    expect(text).not.toContain('dummy-secret');
  });

  it('git_show reads a file at the worker commit, by SHA and by branch; a protected file never', async () => {
    expect(await gitShow(repo, { rev: head.slice(0, 12), path: 'docs/guide.md' })).toMatchObject({ ok: true, text: expect.stringContaining('Hello.') });
    expect(await gitShow(repo, { rev: 'wtask/docs-1', path: 'docs/guide.md' })).toMatchObject({ ok: true });
    expect(await gitShow(repo, { rev: head, path: '.env' })).toMatchObject({ ok: false, reason: expect.stringContaining('protected') });
    expect(await gitShow(repo, { rev: head, path: 'nope.md' })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
    expect(await gitShow(repo, { rev: 'f'.repeat(40), path: 'README.md' })).toMatchObject({ ok: false, reason: expect.stringContaining('not a commit') });
  });

  it('the in-process server lists both tools and answers a call; a refusal answers an error result', async () => {
    let refuse: string | null = null;
    const cfg = createBotRepoGitServer(repo, () => refuse);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await cfg.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['git_diff', 'git_show']);
      const ok = await client.callTool({ name: 'git_show', arguments: { rev: head, path: 'docs/guide.md' } });
      expect(ok.isError).toBeFalsy();
      expect(JSON.stringify(ok.content)).toContain('Hello.');
      refuse = 'this turn comes from an external guest';
      const no = await client.callTool({ name: 'git_diff', arguments: { base: 'main', head } });
      expect(no.isError).toBe(true);
      expect(JSON.stringify(no.content)).toContain('external guest');
    } finally {
      await client.close();
    }
  });
});
