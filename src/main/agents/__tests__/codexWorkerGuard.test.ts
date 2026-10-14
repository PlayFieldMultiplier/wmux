// pty:create's codex bot-worker stage: real git worktree, a stand-in codex
// (its version and its rules check are scripted).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() } }));

import { guardCodexBotWorker, type CodexGuardRun } from '../codexWorkerGuard';
import { beginBotWorkerSpawn, claimInflightCodexLaunch, guardedCodexCwdRefusal, isGuardedCodexCreate, withBotWorkerMergeGuard } from '../botWorkerMergeGuard';
import { CODEX_WORKER_EXCLUDE_LINE, CODEX_WORKER_RULES_PATH } from '../../../shared/codexWorkerGuard';
import { codexTrustOverride } from '../../../shared/fanoutPreset';

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let wt: string;
let canary: { decision: string; ours: boolean; code: number };
let version: string;
let calls: string[][];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-guard-')));
  repo = path.join(root, 'repo');
  wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  sh(repo, 'worktree', 'add', '-q', '-b', 'wtask/x', wt);
  canary = { decision: 'forbidden', ours: true, code: 0 };
  version = 'codex-cli 0.162.1';
  calls = [];
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const run = async (cmd: string, args: string[], opts: { cwd: string }): Promise<CodexGuardRun> => {
  calls.push([cmd, ...args]);
  if (cmd === '/fake/codex') {
    if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    const matched = canary.ours ? [{ prefixRuleMatch: { justification: 'wmux bot worker: x' } }] : [];
    return { code: canary.code, stdout: JSON.stringify({ decision: canary.decision, matchedRules: matched }), stderr: canary.code ? 'Error loading rules' : '' };
  }
  try {
    return { code: 0, stdout: execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: String(err) };
  }
};
const deps = { run, resolveCodex: async () => '/fake/codex', paneEnv: async () => process.env, repoKey: () => 'acme/app', platform: 'darwin' as const, claimLaunch: () => true, get home() { return root; } };
const PROMPT = `"$(cat '/data/.meta/x/prompt.md')"`;
const line = () => `codex ${codexTrustOverride(wt, 'darwin')} -a never -s workspace-write ${PROMPT}`;
const strict = { strict: true, spawns: [{ botId: 'bot-00000001' }] };

describe('guardCodexBotWorker', () => {
  it('writes the rules, excludes them, proves they load and rebuilds the line', async () => {
    const out = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps);
    const rules = fs.readFileSync(path.join(wt, CODEX_WORKER_RULES_PATH), 'utf8');
    expect(rules).toContain('["git", "push"]');
    expect(rules).toContain('"--repo=acme/app"');
    const common = sh(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n')).toContain(CODEX_WORKER_EXCLUDE_LINE);
    expect(sh(wt, 'status', '--porcelain')).toBe('');
    expect(out!.initialCommand).toContain('-s workspace-write -c \'sandbox_workspace_write.writable_roots=[');
    expect(out!.initialCommand).toContain(common);
    expect(out!.initialCommand.endsWith(`-C '${wt}' -- ${PROMPT}`)).toBe(true);
    const check = calls.find((c) => c[1] === 'execpolicy')!;
    expect(check).toContain(path.join(wt, CODEX_WORKER_RULES_PATH));
    // The merge guard lets exactly that create through; a copy of its line is not it.
    expect(withBotWorkerMergeGuard(out, { workspaceId: 'ws', strict: true })).toBe(out);
    expect(isGuardedCodexCreate({ initialCommand: out!.initialCommand })).toBe(false);
    expect(() => withBotWorkerMergeGuard({ ...out! }, { workspaceId: 'ws', strict: true })).toThrow(/did not build/);
    // It starts in the folder it was checked in, nowhere else.
    expect(guardedCodexCwdRefusal(out, { source: 'requested', safeCwd: wt })).toBeNull();
    expect(guardedCodexCwdRefusal(out, { source: 'recovery-cwd', safeCwd: wt })).toMatch(/only in the folder/);
    expect(guardedCodexCwdRefusal(out, { source: 'requested', safeCwd: root })).toMatch(/only in the folder/);
    expect(guardedCodexCwdRefusal({ initialCommand: 'claude' }, { source: 'fallback' })).toBeNull();
    // A second launch keeps one exclude line.
    await guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps);
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === CODEX_WORKER_EXCLUDE_LINE)).toHaveLength(1);
  });

  it('leaves a claude line, a non-bot create and no line alone', async () => {
    const claude = { initialCommand: 'claude "$(cat \'/p\')"', cwd: wt };
    expect(await guardCodexBotWorker(claude, strict, deps)).toBe(claude);
    const human = { initialCommand: line(), cwd: wt };
    expect(await guardCodexBotWorker(human, null, deps)).toBe(human);
  });

  it('refuses a later launch, Windows, and a line outside the allowlist', async () => {
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, { strict: false }, deps)).rejects.toThrow(/first launch/);
    // Strict from the renderer's lineage alone (no in-flight spawn main marked) is not the first launch.
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, { strict: true }, deps)).rejects.toThrow(/first launch/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, claimLaunch: () => false })).rejects.toThrow(/first launch/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, platform: 'win32' })).rejects.toThrow(/Windows/);
    await expect(guardCodexBotWorker({ initialCommand: line().replace('-a never', '--yolo'), cwd: wt }, strict, deps)).rejects.toThrow(/allows/);
  });

  it('refuses a .codex folder too large to check', async () => {
    fs.mkdirSync(path.join(wt, '.codex', 'many'), { recursive: true });
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(wt, '.codex', 'many', `f${i}`), '');
    sh(wt, 'add', '.codex');
    sh(wt, 'commit', '-qm', 'many');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/more than 500/);
  });

  it('refuses untracked .codex content, a symlink, and a tracked file at the rules path', async () => {
    fs.mkdirSync(path.join(wt, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.codex', 'config.toml'), 'x = 1\n');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/does not track.*config\.toml/);
    // Tracked content is the owner's: allowed.
    sh(wt, 'add', '.codex/config.toml');
    sh(wt, 'commit', '-qm', 'cfg');
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).resolves.toBeTruthy();
    fs.rmSync(path.join(wt, '.codex', 'rules'), { recursive: true, force: true });
    fs.symlinkSync(root, path.join(wt, '.codex', 'rules'));
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/symlink/);
    fs.unlinkSync(path.join(wt, '.codex', 'rules'));
    fs.mkdirSync(path.join(wt, '.codex', 'rules'));
    fs.writeFileSync(path.join(wt, CODEX_WORKER_RULES_PATH), '# repo copy\n');
    sh(wt, 'add', '-f', CODEX_WORKER_RULES_PATH);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/tracks/);
  });

  it('fails closed when the rules do not load, the decision is not ours, or codex is too old or missing', async () => {
    canary = { decision: 'forbidden', ours: true, code: 1 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'forbidden', ours: false, code: 0 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'allow', ours: true, code: 0 };
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/do not load/);
    canary = { decision: 'forbidden', ours: true, code: 0 };
    version = 'codex-cli 0.150.0';
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, deps)).rejects.toThrow(/older than/);
    await expect(guardCodexBotWorker({ initialCommand: line(), cwd: wt }, strict, { ...deps, resolveCodex: async () => null })).rejects.toThrow(/not on the pane/);
  });

  it('checks every rules file the session reads, the user\'s included', async () => {
    fs.mkdirSync(path.join(root, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'rules', 'default.rules'), '');
    await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, '.codex') } }, strict, deps);
    expect(calls.find((c) => c[1] === 'execpolicy')).toContain(path.join(root, '.codex', 'rules', 'default.rules'));
  });

  it('approves the worker\'s wmux tools only when the codex config defines the wmux server', async () => {
    const without = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, 'none') } }, strict, deps);
    expect(without!.initialCommand).not.toContain('approval_mode');
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[mcp_servers.wmux]\ncommand = "node"\nargs = ["/x/index.js"]\n');
    const withServer = await guardCodexBotWorker({ initialCommand: line(), cwd: wt, env: { CODEX_HOME: path.join(root, '.codex') } }, strict, deps);
    expect(withServer!.initialCommand).toContain('-c mcp_servers.wmux.tools.ledger_update.approval_mode=approve');
    expect(withServer!.initialCommand).toContain('-c mcp_servers.wmux.tools.task_push.approval_mode=approve');
    expect(withServer!.initialCommand).not.toMatch(/tools\.(?:terminal_send|channel_post|fanout_start|browser_[a-z_]+)\./);
  });
});

describe('the in-flight spawn launches codex once', () => {
  it('claims once per spawn, and not without one', () => {
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
    const release = beginBotWorkerSpawn('ws-owner', '/w/one', { botId: 'bot-00000001', taskId: 'wtask-1' });
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(true);
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
    expect(claimInflightCodexLaunch('', '/w/one')).toBe(false);
    release();
    expect(claimInflightCodexLaunch('ws-owner', '/w/one')).toBe(false);
  });
});

describe('the merge guard refuses codex lines it did not see built', () => {
  it('a strict create with a raw codex line', () => {
    expect(() => withBotWorkerMergeGuard({ initialCommand: line() }, { workspaceId: 'ws', strict: true })).toThrow(/did not build/);
  });
});
