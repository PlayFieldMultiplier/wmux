// The worker fence's pure parts: the settings it builds and how a launch
// line and the launch's other settings are merged with it.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  buildWorkerFence,
  mergeWorkerFenceSettings,
  workerFenceCredentialPaths,
  workerFenceGitDenies,
  workerFenceHookCommand,
  workerFenceLaunch,
  workerFencePermissionDenies,
  workerFenceWorktreeDenies,
  WORKER_FENCE_FILE_ALLOW_RULE,
  WORKER_FENCE_REFUSED_PERMISSION_KEYS,
  WORKER_FENCE_REFUSED_SETTINGS_KEYS,
  type WorkerFenceInput,
} from '../workerFence';
import { WORKER_GATE_TIMEOUT_S } from '../workerToolGate';
import { BOT_WORKER_DENY } from '../../../shared/botWorkerGuard';
import { wslClaudeHooks } from '../../../shared/wslIntegration';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';

const HOME = path.resolve('/home/me');
const GIT = path.join(HOME, 'src', 'repo', '.git');
const WT = path.join(HOME, '.wmux', 'worktrees', 'task-1');
const TMP = path.join(HOME, '.wmux', 'worker-tmp', 'task-1');
const HOOK = 'ELECTRON_RUN_AS_NODE=1 "/opt/wmux" "/home/me/.wmux/factory/worker-hooks/abc.cjs" "/w" "/t" || exit 2';

function input(over: Partial<WorkerFenceInput> = {}): WorkerFenceInput {
  return {
    worktree: WT,
    workerTempDir: TMP,
    gitCommonDir: GIT,
    isLinkedWorktree: true,
    ownWorktreeName: 'task-1',
    ownBranch: 'wmux/task-1',
    otherBranches: ['main', 'wmux/task-1', 'wmux/task-2', 'fix(x)'],
    otherWorktrees: ['task-1', 'task-2'],
    platformCapable: true,
    repoTestWritePaths: ['/private/tmp/wmux-test-*'],
    permissionMode: 'bypassPermissions',
    hookCommand: HOOK,
    credentialPaths: [path.join(HOME, '.ssh'), path.join(HOME, '.claude', '.credentials.json'), path.join(HOME, '.wmux'), path.join(HOME, '.wmux-auth-token')],
    home: HOME,
    ...over,
  };
}

const sandboxOf = (s: Record<string, unknown>) => s.sandbox as { filesystem: Record<string, string[]>; network: Record<string, unknown>; autoAllowBashIfSandboxed: boolean } & Record<string, unknown>;
const g = (...p: string[]) => path.join(GIT, ...p);

describe('the git denies', () => {
  it('a linked worktree: packs, other refs, HEAD, hooks, config, the main index, its own config.worktree, other worktrees', () => {
    const d = workerFenceGitDenies(input());
    for (const p of [
      g('objects', 'pack'), g('packed-refs'), g('refs', 'remotes'), g('refs', 'tags'), g('refs', 'replace'), g('refs', 'notes'), g('HEAD'), g('index'),
      g('hooks'), g('config'), g('info'), g('objects', 'info'), g('modules'), g('shallow'), g('reftable'),
      g('worktrees', 'task-1', 'config.worktree'), g('worktrees', 'task-1', 'commondir'), g('worktrees', 'task-1', 'gitdir'), g('worktrees', 'task-2'),
    ]) {
      expect(d, p).toContain(p);
    }
    expect(d).not.toContain(g('worktrees', 'task-1'));
    expect(d).not.toContain(g('refs', 'heads'));
  });

  it('a main-checkout worker keeps its own index and config.worktree is the common dir\'s', () => {
    const d = workerFenceGitDenies(input({ isLinkedWorktree: false, ownWorktreeName: null, otherWorktrees: ['task-2'] }));
    expect(d).not.toContain(g('index'));
    expect(d).not.toContain(g('commondir'));
    expect(d).toContain(g('HEAD'));
    expect(d).toContain(g('config.worktree'));
    expect(d).toContain(g('worktrees', 'task-2'));
  });

  it('denies every other branch by its own ref file and leaves the worker\'s own open', () => {
    const d = workerFenceGitDenies(input());
    expect(d).toContain(g('refs', 'heads', 'main'));
    expect(d).toContain(g('refs', 'heads', 'wmux', 'task-2'));
    expect(d).toContain(g('refs', 'heads', 'fix(x)'));
    expect(d).not.toContain(g('refs', 'heads', 'wmux', 'task-1'));
    // Detached: every branch is someone else's.
    expect(workerFenceGitDenies(input({ ownBranch: null }))).toContain(g('refs', 'heads', 'wmux', 'task-1'));
  });

  it('refuses a name that would not join as itself, and a linked worktree with no name', () => {
    for (const b of ['../x', 'a/../../b', 'a//b', '', 'a\\b', 'a\nb']) expect(() => workerFenceGitDenies(input({ otherBranches: [b] })), JSON.stringify(b)).toThrow(/refs\/heads/);
    for (const n of ['..', 'a/b', '']) expect(() => workerFenceGitDenies(input({ otherWorktrees: [n] }))).toThrow(/folder name/);
    expect(() => workerFenceGitDenies(input({ ownWorktreeName: null }))).toThrow(/linked worktree/);
    expect(() => workerFenceGitDenies(input({ gitCommonDir: 'repo/.git' }))).toThrow(/absolute/);
  });
});

describe('the fence settings', () => {
  it('a capable platform: the sandbox, the temp and cache redirects, the denies and the hook', () => {
    const { settings, weaker } = buildWorkerFence(input());
    expect(weaker).toBe(false);
    const sb = sandboxOf(settings);
    expect(sb).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, enableWeakerNestedSandbox: false });
    expect(sb.filesystem.allowWrite).toEqual([WT, TMP, GIT, '/private/tmp/wmux-test-*']);
    expect(sb.filesystem.denyWrite).toEqual([...workerFenceWorktreeDenies(WT, true), ...workerFenceGitDenies(input())]);
    for (const p of [['.claude', 'settings.json'], ['.claude', 'settings.local.json'], ['.mcp.json'], ['.git']]) expect(sb.filesystem.denyWrite).toContain(path.join(WT, ...p));
    // Instructions stay writable: repositories track them, and git rewrites them.
    for (const p of [['CLAUDE.md'], ['CLAUDE.local.md'], ['.claude']]) expect(sb.filesystem.denyWrite).not.toContain(path.join(WT, ...p));
    expect(workerFenceWorktreeDenies(WT, false)).not.toContain(path.join(WT, '.git'));
    expect(sb.filesystem.denyRead).toContain(path.join(HOME, '.ssh'));
    // Every denied folder that holds one of the worker's folders re-opens it.
    for (const own of [WT, TMP, GIT]) expect(sb.filesystem.allowRead).toContain(own);
    expect(sb.network).toMatchObject({ strictAllowlist: false, allowLocalBinding: true, allowUnixSockets: [TMP, '/private/tmp/wmux-test-*'] });
    expect(settings.env).toEqual({
      CLAUDE_CODE_TMPDIR: TMP,
      npm_config_cache: path.join(TMP, 'npm-cache'),
      PIP_CACHE_DIR: path.join(TMP, 'pip-cache'),
      CARGO_HOME: path.join(TMP, 'cargo-home'),
    });
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.hooks).toEqual({ PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: HOOK, timeout: WORKER_GATE_TIMEOUT_S }] }] });
  });

  it('sandboxed commands run without asking only in bypass mode', () => {
    expect(sandboxOf(buildWorkerFence(input({ permissionMode: 'bypassPermissions' })).settings).autoAllowBashIfSandboxed).toBe(true);
    expect(sandboxOf(buildWorkerFence(input({ permissionMode: 'auto' })).settings).autoAllowBashIfSandboxed).toBe(false);
  });

  it('a platform without the sandbox: the hook, the permission denies and the temp folder only, marked weaker', () => {
    const { settings, weaker } = buildWorkerFence(input({ platformCapable: false }));
    expect(weaker).toBe(true);
    expect(Object.keys(settings).sort()).toEqual(['disableAllHooks', 'env', 'hooks', 'permissions']);
    expect((settings.env as Record<string, string>).CLAUDE_CODE_TMPDIR).toBe(TMP);
    expect((settings.permissions as { deny: string[] }).deny).toContain('Read(~/.ssh/**)');
  });

  it('refuses a relative path and a missing hook command', () => {
    expect(() => buildWorkerFence(input({ worktree: 'wt' }))).toThrow(/absolute/);
    expect(() => buildWorkerFence(input({ repoTestWritePaths: ['tmp/x'] }))).toThrow(/absolute/);
    expect(() => buildWorkerFence(input({ hookCommand: ' ' }))).toThrow(/hook/);
  });
});

describe('the credential set', () => {
  it('permission denies name each path and its contents for Read, Edit and Write, never a folder of the worker\'s own', () => {
    const deny = workerFencePermissionDenies(input().credentialPaths, [WT, TMP, GIT], HOME);
    for (const t of ['Read', 'Edit', 'Write']) {
      expect(deny).toContain(`${t}(~/.ssh)`);
      expect(deny).toContain(`${t}(~/.ssh/**)`);
      expect(deny).toContain(`${t}(~/.claude/.credentials.json)`);
      expect(deny).toContain(`${t}(~/.wmux-auth-token)`);
    }
    // ~/.wmux holds the worktree: a deny there would close it to the file tools.
    expect(deny.some((r) => r.includes('~/.wmux)') || r.includes('~/.wmux/**'))).toBe(false);
    expect(workerFencePermissionDenies(['/etc/secret'], [WT], HOME)).toContain('Read(//etc/secret)');
  });

  it('is the bot sandbox\'s list without home, without gh, with Claude folders narrowed to their sign-in file', () => {
    const cfg = path.join(HOME, 'accounts', 'a');
    const paths = workerFenceCredentialPaths({ botDir: WT, wmuxDir: path.join(HOME, '.wmux'), env: { CLAUDE_CONFIG_DIR: cfg }, home: HOME, platform: 'linux', listDir: () => [] });
    expect(paths).not.toContain(HOME);
    expect(paths).not.toContain(path.join(HOME, '.config', 'gh'));
    expect(paths).not.toContain(path.join(HOME, '.claude'));
    expect(paths.some((p) => p.endsWith('shell-snapshots'))).toBe(false);
    expect(paths).not.toContain(path.join(HOME, '.claude', '.claude.json'));
    for (const p of [path.join(HOME, '.ssh'), path.join(HOME, '.aws'), path.join(HOME, '.claude.json'), path.join(HOME, '.claude', '.credentials.json'), path.join(cfg, '.credentials.json'), path.join(cfg, '.claude.json')]) {
      expect(paths, p).toContain(p);
    }
  });
});

describe('the hook command', () => {
  it('runs the runtime as node with the roots after the script, and refuses what a shell would read', () => {
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w t', '/tmp/x'])).toBe('ELECTRON_RUN_AS_NODE=1 "/opt/wmux" "/d/hook.cjs" "/w t" "/tmp/x" || exit 2');
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', [])).toBeNull();
    expect(workerFenceHookCommand('node', '/d/hook.cjs', ['/w'])).toBeNull();
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w/$(x)'])).toBeNull();
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w/"x'])).toBeNull();
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w/a\\b'])).toBeNull();
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w/a`b'])).toBeNull();
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/w/a\nb'])).toBeNull();
    // Any other character reads as itself inside double quotes.
    expect(workerFenceHookCommand('/opt/wmux', '/d/hook.cjs', ['/Users/me/코딩/a+b@c (1)'])).toBe('ELECTRON_RUN_AS_NODE=1 "/opt/wmux" "/d/hook.cjs" "/Users/me/코딩/a+b@c (1)" || exit 2');
  });
});

describe('the fenced launch', () => {
  const fence = buildWorkerFence(input()).settings;
  const SETTINGS = '/home/me/.wmux/factory/worker-settings/abc.json';
  const launch = (line: string, extras: Record<string, unknown>[] = []) => workerFenceLaunch({ line, settingsPath: SETTINGS, fence, extras });

  it('splices the settings flag after claude, keeping the model-env marker', () => {
    const r = launch(`${MODEL_ENV_MARKER}claude --dangerously-skip-permissions "do it"`);
    expect(r).toMatchObject({ ok: true, line: `${MODEL_ENV_MARKER}claude --settings="${SETTINGS}" --dangerously-skip-permissions "do it"` });
    // Already carrying exactly this file: unchanged.
    const again = launch(`claude --settings="${SETTINGS}" -p x`);
    expect(again).toMatchObject({ ok: true, line: `claude --settings="${SETTINGS}" -p x` });
  });

  it('refuses each line the fence cannot be attached to, with its reason', () => {
    const cases: Array<[string, string]> = [
      ['codex --yolo', 'not-claude'],
      ['', 'not-claude'],
      ['env FOO=1 claude', 'wrapper'],
      ['FOO=1 claude', 'wrapper'],
      ['sh -c "claude -p x"', 'wrapper'],
      ['bash -lc claude', 'wrapper'],
      ['npx claude', 'wrapper'],
      ['claude --settings /x.json', 'settings-flag'],
      ['claude "--settings=/x.json"', 'settings-flag'],
      ['claude ; rm x', 'unspliceable'],
      ['claude -p x | tee log', 'unspliceable'],
      ['claude $FLAGS', 'unspliceable'],
      ['claude -- x', 'unspliceable'],
      ['claude --add-dir /', 'add-dir'],
      ['claude --add-dir=/Users', 'add-dir'],
    ];
    for (const [line, refusal] of cases) expect(launch(line), line).toMatchObject({ ok: false, refusal });
  });

  it('keeps the WSL hooks and the bot deny rules after the fence\'s own hook', () => {
    const r = launch('claude', [{ hooks: wslClaudeHooks() }, { permissions: { deny: [...BOT_WORKER_DENY] }, disableAllHooks: false }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hooks = r.settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse[0]).toEqual((fence.hooks as Record<string, unknown[]>).PreToolUse[0]);
    expect(hooks.PreToolUse.slice(1)).toEqual(wslClaudeHooks().PreToolUse);
    expect(hooks.Stop).toEqual(wslClaudeHooks().Stop);
    const deny = (r.settings.permissions as { deny: string[] }).deny;
    expect(deny).toEqual(expect.arrayContaining([...BOT_WORKER_DENY, 'Read(~/.ssh/**)']));
    expect(r.settings.sandbox).toEqual(fence.sandbox);
  });

  it('refuses an extra that would change the fence', () => {
    expect(launch('claude', [{ sandbox: { enabled: false } }])).toMatchObject({ ok: false, refusal: 'conflict' });
    expect(launch('claude', [{ disableAllHooks: true }])).toMatchObject({ ok: false, refusal: 'conflict', reason: expect.stringMatching(/disableAllHooks/) });
    expect(launch('claude', [{ env: { CLAUDE_CODE_TMPDIR: '/tmp' } }])).toMatchObject({ ok: false, refusal: 'conflict', reason: expect.stringMatching(/env\.CLAUDE_CODE_TMPDIR/) });
    expect(mergeWorkerFenceSettings(fence, [JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>])).toEqual({ ok: false, key: '__proto__' });
    // What claude widens the sandbox's writes by.
    expect(mergeWorkerFenceSettings(fence, [{ permissions: { additionalDirectories: ['/Users'] } }])).toEqual({ ok: false, key: 'permissions.additionalDirectories' });
    for (const rule of ['Edit(//Users/**)', 'Write', 'Read(~/x)', 'MultiEdit(/a)']) {
      expect(mergeWorkerFenceSettings(fence, [{ permissions: { allow: [rule] } }]), rule).toEqual({ ok: false, key: 'permissions.allow' });
    }
    expect(mergeWorkerFenceSettings(fence, [{ permissions: { allow: ['Bash(npm test)', 'mcp__notion'] } }]).ok).toBe(true);
    // The fence itself is never changed by a merge.
    const before = JSON.stringify(fence);
    mergeWorkerFenceSettings(fence, [{ hooks: wslClaudeHooks() }, { env: { EXTRA: '1' } }]);
    expect(JSON.stringify(fence)).toBe(before);
  });
});

describe('what a fenced worker\'s other settings may not set', () => {
  it('names the keys and rules that would loosen the fence', () => {
    expect(WORKER_FENCE_REFUSED_SETTINGS_KEYS).toEqual(['sandbox', 'disableAllHooks']);
    expect(WORKER_FENCE_REFUSED_PERMISSION_KEYS).toEqual(['additionalDirectories']);
    for (const r of ['Edit(//x/**)', 'Write', 'Read(~/a)', 'NotebookEdit(/n)']) expect(WORKER_FENCE_FILE_ALLOW_RULE.test(r), r).toBe(true);
    for (const r of ['Bash(npm test)', 'mcp__notion', 'WebFetch', 'Readme']) expect(WORKER_FENCE_FILE_ALLOW_RULE.test(r), r).toBe(false);
  });
});
