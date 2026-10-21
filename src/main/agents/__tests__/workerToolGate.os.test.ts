// The tool gate of a worker with a signed-in connection: the generated hook
// script, run as claude runs it (its command through a shell, the call as
// JSON on stdin, exit 2 refuses).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerToolGateCommand, workerToolGateScript } from '../workerToolGate';

// Signed-in connections reach workers on macOS and Linux only.
const WIN = process.platform === 'win32';
let base: string;
let command: string;

function run(call: unknown): { code: number | null; err: string } {
  const r = spawnSync('/bin/sh', ['-c', command], { input: typeof call === 'string' ? call : JSON.stringify(call), encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}
const passes = (tool_name: string) => run({ tool_name, tool_input: {} }).code === 0;

beforeAll(() => {
  if (WIN) return;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tool-gate-')));
  const gate = path.join(base, 'gate.cjs');
  fs.writeFileSync(gate, workerToolGateScript(['notion']));
  command = workerToolGateCommand(process.execPath, gate)!;
});
afterAll(() => {
  if (WIN) return;
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(WIN)('the tool allowlist', () => {
  it('passes Bash, TodoWrite, the task\'s gateway tools and ledger_update', () => {
    for (const t of ['Bash', 'TodoWrite', 'mcp__notion__read_page', 'mcp__wmux__ledger_update']) expect(passes(t), t).toBe(true);
  });

  it('refuses every built-in file tool: they run outside the command sandbox', () => {
    for (const t of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']) expect(passes(t), t).toBe(false);
  });

  it('refuses any other tool, known or not', () => {
    for (const t of ['ToolSearch', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'KillShell', 'Frobnicate', 'mcp__wmux__channel_post', 'mcp__wmux__task_push', 'mcp__other__x', 'mcp__notionx__y', 'mcp__notion__', '']) {
      expect(passes(t), t).toBe(false);
    }
  });

  it('refuses with exit 2 and a reason on stderr, and refuses a call it cannot read', () => {
    const r = run({ tool_name: 'Read', tool_input: { file_path: 'x' } });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^wmux: Read is not available .*use Bash for files/);
    expect(run('not json').code).toBe(2);
    expect(run('').code).toBe(2);
  });

  it('refuses when its runtime cannot run it', () => {
    const missing = workerToolGateCommand('/nonexistent/wmux', path.join(base, 'gate.cjs'))!;
    const r = spawnSync('/bin/sh', ['-c', missing], { input: JSON.stringify({ tool_name: 'Bash' }), encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('the gate command', () => {
  it('runs the given runtime by its absolute path, as node', () => {
    expect(workerToolGateCommand('/Applications/wmux.app/Contents/MacOS/wmux', '/Users/me/.wmux/factory/worker-hooks/0123456789ab.cjs'))
      .toBe('ELECTRON_RUN_AS_NODE=1 "/Applications/wmux.app/Contents/MacOS/wmux" "/Users/me/.wmux/factory/worker-hooks/0123456789ab.cjs" || exit 2');
  });

  it('refuses a runtime from PATH and a path a shell would read', () => {
    expect(workerToolGateCommand('node', '/w/gate.cjs')).toBeNull();
    expect(workerToolGateCommand('/opt/$(x)/wmux', '/w/gate.cjs')).toBeNull();
    expect(workerToolGateCommand('/opt/wmux', '/w/"gate.cjs')).toBeNull();
    expect(workerToolGateCommand('/opt/wmux', 'gate.cjs')).toBeNull();
  });
});
