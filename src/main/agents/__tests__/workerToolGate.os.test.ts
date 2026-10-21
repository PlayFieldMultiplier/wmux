// The tool gate of a worker with a signed-in connection: the generated hook
// script, run as claude runs it (the call as JSON on stdin, exit 2 refuses),
// against checkBotFolderPath on the same paths.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerToolGateScript } from '../workerToolGate';
import { checkBotFolderPath } from '../../factory/botFolderPath';

// Signed-in connections reach workers on macOS and Linux only.
const WIN = process.platform === 'win32';
let base: string;
let task: string;
let scratch: string;
let outside: string;
let gate: string;

function run(call: unknown): { code: number | null; err: string } {
  const r = spawnSync(process.execPath, [gate], { input: typeof call === 'string' ? call : JSON.stringify(call), encoding: 'utf8', cwd: task });
  return { code: r.status, err: r.stderr };
}
const passes = (tool_name: string, tool_input: Record<string, unknown> = {}) => run({ tool_name, tool_input }).code === 0;

beforeAll(() => {
  if (WIN) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tool-gate-')));
  task = path.join(base, 'task');
  scratch = path.join(base, 'task-tmp');
  outside = path.join(base, 'outside');
  for (const d of [task, scratch, outside, path.join(task, 'sub'), path.join(task, '.claude')]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['a.txt', 'sub/b.txt', 'package.json', '.env', '.claude/settings.json', 'CLAUDE.md']) fs.writeFileSync(path.join(task, f), 'x');
  fs.writeFileSync(path.join(scratch, 'c.txt'), 'x');
  fs.writeFileSync(path.join(scratch, 'twin.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(task, 'link.txt'));
  fs.symlinkSync(outside, path.join(task, 'linkdir'));
  // The same name: a link in the task folder, a regular file in the temp one.
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(task, 'twin.txt'));
  gate = path.join(base, 'gate.cjs');
  fs.writeFileSync(gate, workerToolGateScript({ roots: [task, scratch], connections: ['notion'] }));
});
afterAll(() => {
  if (WIN) return;
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(WIN)('the file tools (a port of checkBotFolderPath)', () => {
  it('decides a Write path as checkBotFolderPath does in either folder', () => {
    const paths = [
      'a.txt', 'sub/b.txt', 'sub/new.txt', 'new/deeper/x.txt', 'package.json', '.env', '.claude/settings.json', 'link.txt', 'linkdir/secret.txt',
      '../outside/secret.txt', 'sub/../a.txt', '', '/etc/hosts',
      path.join(task, 'a.txt'), path.join(task, 'sub'), path.join(scratch, 'c.txt'), path.join(scratch, 'n.txt'), path.join(outside, 'secret.txt'),
      path.join(task, '.git', 'config'), path.join(task, 'id_rsa'), path.join(task, '.github', 'workflows', 'x.yml'),
    ];
    for (const p of paths) {
      const expected = checkBotFolderPath(p, task).ok || (path.isAbsolute(p) && checkBotFolderPath(p, scratch).ok);
      expect(passes('Write', { file_path: p, content: 'y' }), p).toBe(expected);
    }
  });

  it('protects the folder\'s claude config names too, and takes no home path', () => {
    expect(passes('Edit', { file_path: 'CLAUDE.md', old_string: 'x', new_string: 'y' })).toBe(false);
    expect(passes('Write', { file_path: '.mcp.json', content: '{}' })).toBe(false);
    expect(passes('Write', { file_path: 'sub/CLAUDE.local.md', content: '' })).toBe(false);
    expect(passes('Read', { file_path: '~/.ssh/config' })).toBe(false);
    expect(passes('Read', { file_path: '~' })).toBe(false);
  });

  it('checks a relative path against the task folder only', () => {
    // Claude reads it from its working folder, where it is a link.
    expect(passes('Read', { file_path: 'twin.txt' })).toBe(false);
    expect(passes('Read', { file_path: path.join(scratch, 'twin.txt') })).toBe(true);
  });

  it('confines Read, NotebookEdit, Glob and Grep the same way', () => {
    expect(passes('Read', { file_path: path.join(task, 'a.txt') })).toBe(true);
    expect(passes('Read', { file_path: path.join(outside, 'secret.txt') })).toBe(false);
    expect(passes('Read', {})).toBe(false);
    expect(passes('NotebookEdit', { notebook_path: '/etc/x.ipynb', new_source: '' })).toBe(false);
    expect(passes('Glob', { pattern: '**/*.txt' })).toBe(true);
    expect(passes('Glob', { pattern: '*.txt', path: task })).toBe(true);
    expect(passes('Glob', { pattern: '*', path: outside })).toBe(false);
    expect(passes('Glob', { pattern: '/etc/*' })).toBe(false);
    expect(passes('Glob', { pattern: '../**' })).toBe(false);
    expect(passes('Glob', { pattern: '{a,..}/x' })).toBe(false);
    expect(passes('Grep', { pattern: 'x' })).toBe(true);
    expect(passes('Grep', { pattern: 'x', path: 'sub' })).toBe(true);
    expect(passes('Grep', { pattern: 'x', path: base })).toBe(false);
    expect(passes('Grep', { pattern: 'x', glob: '~/.aws/*' })).toBe(false);
  });
});

describe.skipIf(WIN)('the tool allowlist', () => {
  it('passes the task\'s tools and refuses everything else', () => {
    for (const t of ['Bash', 'TodoWrite', 'ToolSearch', 'mcp__notion__read_page', 'mcp__wmux__ledger_update']) expect(passes(t, { command: 'ls' }), t).toBe(true);
    for (const t of ['Task', 'Agent', 'WebFetch', 'WebSearch', 'mcp__wmux__channel_post', 'mcp__wmux__task_push', 'mcp__other__x', 'mcp__notionx__y', 'KillShell', '']) {
      expect(passes(t, {}), t).toBe(false);
    }
  });

  it('refuses with exit 2 and a reason on stderr, and refuses a call it cannot read', () => {
    const r = run({ tool_name: 'WebFetch', tool_input: {} });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^wmux: WebFetch is not available/);
    expect(run('not json').code).toBe(2);
    expect(run('').code).toBe(2);
  });
});
