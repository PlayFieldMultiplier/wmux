// The worker fence's hook, run as claude runs it: its command through a
// shell, the call as JSON on stdin; exit 0 lets the call run, anything else
// must be exit 2 (any other code would let it run too).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerFenceHookCommand, workerFenceHookScript } from '../workerFence';

// The hook command is a POSIX shell line; Windows workers are wired in a later step.
const WIN = process.platform === 'win32';
let base: string;
let wt: string;
let tmp: string;
let outside: string;
let script: string;
let command: string;

function runWith(cmd: string, call: unknown): { code: number | null; err: string } {
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: typeof call === 'string' ? call : JSON.stringify(call), encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}
const run = (call: unknown) => runWith(command, call);
function hookCommand(runtime: string, file: string, roots: string[]): string {
  const c = workerFenceHookCommand(runtime, file, roots);
  if (c === null) throw new Error('the hook command could not be built');
  return c;
}
const write = (file_path: unknown, tool_name = 'Write') => run({ tool_name, tool_input: { file_path, content: 'x' } }).code;

beforeAll(() => {
  if (WIN) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fence-hook-')));
  wt = path.join(base, 'wt');
  tmp = path.join(base, 'tmp');
  outside = path.join(base, 'outside');
  for (const d of [wt, tmp, outside, path.join(base, 'hooks')]) fs.mkdirSync(d);
  script = path.join(base, 'hooks', 'fence.cjs');
  fs.writeFileSync(script, workerFenceHookScript());
  command = hookCommand(process.execPath, script, [wt, tmp]);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
  fs.writeFileSync(path.join(outside, 'f.txt'), 'f');
});
afterAll(() => {
  if (WIN) return;
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(WIN)('the worker fence hook', () => {
  it('lets a write inside the worktree or the temp folder run, a new folder in it included', () => {
    expect(write(path.join(wt, 'a.txt'))).toBe(0);
    expect(write(path.join(wt, 'b.txt'), 'Edit')).toBe(0);
    expect(write(path.join(wt, 'b.txt'), 'MultiEdit')).toBe(0);
    expect(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(wt, 'n.ipynb') } }).code).toBe(0);
    expect(write(path.join(wt, 'new', 'deeper', 'x.txt'))).toBe(0);
    expect(write(path.join(tmp, 'x.txt'))).toBe(0);
  });

  it('refuses a write outside, a missing parent outside included', () => {
    expect(write(path.join(outside, 'x.txt'))).toBe(2);
    expect(write(path.join(outside, 'nope', 'deeper', 'x.txt'))).toBe(2);
    expect(write(path.join(base, 'x.txt'))).toBe(2);
    expect(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(outside, 'n.ipynb') } }).code).toBe(2);
    const r = run({ tool_name: 'Write', tool_input: { file_path: path.join(outside, 'x.txt') } });
    expect(r.err).toMatch(/^wmux fence: Write to .* is outside the worktree/);
  });

  it('refuses a relative path and a . or .. part, even one that stays inside', () => {
    expect(write('a.txt')).toBe(2);
    expect(run({ tool_name: 'Write', tool_input: { file_path: 'a.txt' }, cwd: wt }).code).toBe(2);
    expect(write(`${wt}/sub/../a.txt`)).toBe(2);
    expect(write(`${wt}/../outside/a.txt`)).toBe(2);
    expect(write(`${wt}/./a.txt`)).toBe(2);
  });

  it('refuses a path through a symlink that leaves the worktree, and a dangling one', () => {
    fs.symlinkSync(outside, path.join(wt, 'link'));
    fs.symlinkSync(path.join(outside, 'f.txt'), path.join(wt, 'filelink'));
    fs.symlinkSync(path.join(outside, 'none.txt'), path.join(wt, 'dangle'));
    expect(write(path.join(wt, 'link', 'x.txt'))).toBe(2);
    expect(write(path.join(wt, 'filelink'))).toBe(2);
    expect(write(path.join(wt, 'dangle'))).toBe(2);
  });

  it('refuses a hard-linked file', () => {
    fs.linkSync(path.join(outside, 'f.txt'), path.join(wt, 'hard.txt'));
    expect(write(path.join(wt, 'hard.txt'), 'Edit')).toBe(2);
  });

  it('refuses the worktree\'s files that run a program at the next session, and git\'s at any depth', () => {
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(base, 'repo', '.git', 'worktrees', 'wt')}\n`);
    for (const p of [
      path.join(wt, '.claude', 'settings.json'),
      path.join(wt, '.claude', 'settings.local.json'),
      path.join(wt, '.Claude', 'Settings.JSON'),
      path.join(wt, '.mcp.json'),
      path.join(wt, '.git'),
      path.join(wt, 'vendor', '.git', 'config'),
    ]) {
      expect(write(p), p).toBe(2);
    }
  });

  it('lets the worker edit claude\'s instructions: CLAUDE.md, skills, agents, nested copies', () => {
    for (const p of [
      path.join(wt, 'CLAUDE.md'),
      path.join(wt, 'CLAUDE.local.md'),
      path.join(wt, '.claude', 'skills', 'x', 'SKILL.md'),
      path.join(wt, '.claude', 'agents', 'a.md'),
      path.join(wt, 'sub', '.claude', 'settings.json'),
      path.join(wt, 'sub', '.mcp.json'),
      path.join(wt, '.github', 'workflows', 'ci.yml'),
    ]) {
      expect(write(p), p).toBe(0);
    }
  });

  it('reads a root with spaces and non-ASCII characters as itself', () => {
    const odd = path.join(base, '작업 폴더 (1)+@');
    fs.mkdirSync(odd);
    const cmd = hookCommand(process.execPath, script, [odd, tmp]);
    expect(runWith(cmd, { tool_name: 'Write', tool_input: { file_path: path.join(odd, 'a.txt') } }).code).toBe(0);
    expect(runWith(cmd, { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'a.txt') } }).code).toBe(2);
  });

  it('refuses a write to the hook script itself', () => {
    const inside = path.join(wt, 'tools', 'fence.cjs');
    fs.mkdirSync(path.dirname(inside));
    fs.writeFileSync(inside, workerFenceHookScript());
    const own = hookCommand(process.execPath, inside, [wt, tmp]);
    expect(runWith(own, { tool_name: 'Write', tool_input: { file_path: inside } }).code).toBe(2);
    expect(runWith(own, { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'ok.txt') } }).code).toBe(0);
    expect(write(script)).toBe(2);
  });

  it('refuses a call it cannot read', () => {
    for (const bad of ['not json', '', '[]', 'null', '{}', JSON.stringify({ tool_name: 42 })]) expect(run(bad).code, JSON.stringify(bad)).toBe(2);
    expect(run({ tool_name: 'Write', tool_input: {} }).code).toBe(2);
    expect(run({ tool_name: 'Write' }).code).toBe(2);
    expect(write(null)).toBe(2);
    expect(write('')).toBe(2);
  });

  it('refuses every call when a root is missing or there is none, or its runtime cannot run', () => {
    const missing = hookCommand(process.execPath, script, [wt, path.join(base, 'missing')]);
    expect(runWith(missing, { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'a.txt') } }).code).toBe(2);
    expect(runWith(missing, { tool_name: 'Bash', tool_input: { command: 'ls' } }).code).toBe(2);
    expect(runWith(`ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${script}" || exit 2`, { tool_name: 'Bash', tool_input: {} }).code).toBe(2);
    const noRuntime = hookCommand('/nonexistent/wmux', script, [wt, tmp]);
    expect(runWith(noRuntime, { tool_name: 'Bash', tool_input: {} }).code).toBe(2);
  });

  it('lets reads, the shells, MCP tools and tools that name no path through', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'touch /x' } }).code).toBe(0);
    expect(run({ tool_name: 'Read', tool_input: { file_path: path.join(outside, 'f.txt') } }).code).toBe(0);
    expect(run({ tool_name: 'Glob', tool_input: { pattern: '*', path: outside } }).code).toBe(0);
    expect(run({ tool_name: 'Grep', tool_input: { pattern: 'x', path: outside } }).code).toBe(0);
    expect(run({ tool_name: 'mcp__wmux__browser_download', tool_input: { path: outside } }).code).toBe(0);
    expect(run({ tool_name: 'TodoWrite', tool_input: { todos: [] } }).code).toBe(0);
    expect(run({ tool_name: 'ToolSearch', tool_input: { query: 'x' } }).code).toBe(0);
  });

  it('refuses a tool that names a path it does not know, and the worktree tools', () => {
    expect(run({ tool_name: 'Frobnicate', tool_input: { file_path: path.join(wt, 'a.txt') } }).code).toBe(2);
    expect(run({ tool_name: 'Frobnicate', tool_input: { path: path.join(wt, 'a.txt') } }).code).toBe(2);
    expect(run({ tool_name: 'EnterWorktree', tool_input: { name: 'x' } }).code).toBe(2);
    expect(run({ tool_name: 'ExitWorktree', tool_input: {} }).code).toBe(2);
    expect(run({ tool_name: 'Agent', tool_input: { prompt: 'x', isolation: 'worktree' } }).code).toBe(2);
    expect(run({ tool_name: 'Task', tool_input: { prompt: 'x', isolation: 'worktree' } }).code).toBe(2);
    expect(run({ tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'Explore' } }).code).toBe(0);
  });
});

