// Agent factory bot mode of the two brain adapters: the MCP child is spawned
// as `<execPath> <bundle> --bot=<role> --bot-token-file=<file>` with no token
// in its environment, the token file holds a live bot token bound to the
// bot, the session runs in the bot's own folder, and (Claude SDK) no
// built-in tool exists in the session — except, for a bot with a repository,
// Read / Grep / Glob, every call decided by main inside that repository.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../commanderMemory', () => ({
  loadCommanderMemory: vi.fn(() => 'MEMORY'),
  loadGlobalMemory: vi.fn(() => ''),
  getMemoryRootDir: vi.fn(() => '/fake/mem'),
}));
vi.mock('../../account/accountStore', () => ({
  VENDOR_ENV_KEYS: { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' },
  isAccessibleDir: () => true,
  getAccountStore: () => ({ resolveAccountEnv: () => ({}), getBinding: () => undefined, getAccount: () => undefined }),
}));
vi.mock('../../account/AccountRotationService', () => ({
  getAccountRotationService: () => ({
    getSettings: () => ({ claude: false, codex: false }),
    prepareLaunch: async () => ({ kind: 'keep' }),
    cachedVerdict: async () => null,
  }),
}));

import { ClaudeSdkAdapter, type SdkQueryHandle } from '../ClaudeSdkAdapter';
import { AcpBrainAdapter } from '../AcpBrainAdapter';
import { botTokenBinding, isCommanderToken } from '../commanderTrust';
import { botArgValue, botTokenFileArgValue, type BotBinding } from '../../../shared/bot';
import type { BrainEvent } from '../BrainAdapter';
import { botRepoReadDenyRules } from '../../factory/botRepoRead';

const BINDING: BotBinding = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'verifier' };
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-adapters-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('ClaudeSdkAdapter bot mode', () => {
  it('spawns the MCP child with bot args and a token file, never a token env, and no built-in tools', async () => {
    const seen: Array<{ options: Record<string, unknown>; tokenAtSpawn: string | null }> = [];
    const cwd = path.join(dir, 'factory', 'bots', BINDING.botId);
    fs.mkdirSync(cwd, { recursive: true });
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd, wmuxDir: dir },
      allowedTools: ['mcp__wmux__pr_read', 'mcp__wmux__room_post'],
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/app/dist/mcp-bundle/index.js',
      queryFn: ({ options = {} }) => {
        const server = (options.mcpServers as Record<string, { args: string[] }>).wmux;
        const file = botTokenFileArgValue(server.args) ?? '';
        seen.push({ options, tokenAtSpawn: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
        const handle: SdkQueryHandle = {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', session_id: 'sess-bot' };
          },
        };
        return handle;
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    const events = await collect(adapter.send('wake'));
    expect(events.at(-1)?.type).toBe('turn-end');

    const { options, tokenAtSpawn } = seen[0];
    const server = (options.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>).wmux;
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toBe('/app/dist/mcp-bundle/index.js');
    expect(botArgValue(server.args)).toBe('verifier');
    expect(server.args).not.toContain('--commander');
    expect(Object.keys(server.env).filter((k) => k !== 'WMUX_DATA_SUFFIX')).toEqual(['ELECTRON_RUN_AS_NODE']);
    expect(JSON.stringify(server.env)).not.toMatch(/TOKEN/);
    // The file held a live token bound to exactly this bot, and was removed after the turn.
    expect(tokenAtSpawn && botTokenBinding(tokenAtSpawn)).toEqual(BINDING);
    expect(fs.existsSync(botTokenFileArgValue(server.args) ?? '')).toBe(false);

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(['mcp__wmux__pr_read', 'mcp__wmux__room_post']);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Read', 'Edit', 'Agent']));
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe(cwd);
    const deny = await (options.canUseTool as (n: string, i: unknown) => Promise<{ behavior: string }>)('Write', { file_path: '/x' });
    expect(deny.behavior).toBe('deny');

    adapter.dispose();
    expect(isCommanderToken(tokenAtSpawn)).toBe(false);
  });

  it('a fresh hand-off file per turn, and no memory in the first prompt', async () => {
    const files: string[] = [];
    const prompts: string[] = [];
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd: dir, wmuxDir: dir },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ prompt, options = {} }) => {
        prompts.push(prompt);
        files.push(botTokenFileArgValue((options.mcpServers as Record<string, { args: string[] }>).wmux.args) ?? '');
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    await collect(adapter.send('one'));
    await collect(adapter.send('two'));
    expect(new Set(files).size).toBe(2);
    expect(prompts[0]).toBe('one');
    adapter.dispose();
  });
});

describe('ClaudeSdkAdapter bot mode with a repository', () => {
  type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  async function optionsFor(repoRoot: string | undefined): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {};
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: { ...BINDING, role: 'lead' }, cwd: path.join(dir, 'bot'), wmuxDir: dir, repoRoot },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ options = {} }) => {
        seen = options;
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    await collect(adapter.send('wake'));
    adapter.dispose();
    return seen;
  }
  const preHook = (o: Record<string, unknown>) => (o.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse[0].hooks[0];
  const postHook = (o: Record<string, unknown>) => (o.hooks as { PostToolUse: Array<{ hooks: Hook[] }> }).PostToolUse[0].hooks[0];
  const canUse = (o: Record<string, unknown>) => o.canUseTool as (n: string, i: Record<string, unknown>) => Promise<Record<string, unknown>>;

  let repo = '';
  beforeEach(() => {
    // The native realpath, as the product resolves (it expands Windows 8.3 short names).
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reporead-adapter-')));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=dummy\n');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('holds Read, Grep and Glob only, none auto-allowed, with protected files denied by rule', async () => {
    const o = await optionsFor(repo);
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.allowedTools).toEqual(expect.not.arrayContaining(['Read', 'Grep', 'Glob']));
    expect((o.allowedTools as string[]).every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']));
    expect(o.disallowedTools).toEqual(expect.not.arrayContaining(['Read', 'Grep', 'Glob']));
    expect((o.settings as { permissions: { deny: string[] } }).permissions.deny).toEqual(botRepoReadDenyRules(repo));
    expect(o.settingSources).toEqual([]);
    // The session folder stays the bot's own; main points the reads at the repository.
    expect(o.cwd).toBe(path.join(dir, 'bot'));
  });

  it('the PreToolUse hook allows reads inside the repository and refuses the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pre = preHook(await optionsFor(repo));
    expect(await pre({ tool_name: 'Grep', tool_input: { pattern: 'a' } })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { pattern: 'a', path: repo } },
    });
    expect(await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: path.join(repo, 'src', 'a.ts') } },
    });
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: path.join(repo, '.env') }],
      ['Read', { file_path: os.homedir() }],
      ['Glob', { pattern: '/etc/*' }],
      ['Bash', { command: 'cat .env' }],
      ['Write', { file_path: path.join(repo, 'src', 'a.ts'), content: '' }],
    ] as const) {
      expect({ tool_name, out: await pre({ tool_name, tool_input }) }).toMatchObject({ tool_name, out: { hookSpecificOutput: { permissionDecision: 'deny' } } });
    }
    // The bot's wmux tools keep their own gates.
    expect(await pre({ tool_name: 'mcp__wmux__room_post', tool_input: {} })).toEqual({});
    expect(warn.mock.calls.some((c) => String(c[0]).includes('bot repository read denied') && String(c[1]).includes('.env'))).toBe(true);
    warn.mockRestore();
  });

  it('canUseTool makes the same decision', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const can = canUse(await optionsFor(repo));
    expect(await can('Glob', { pattern: '**/*.ts' })).toEqual({ behavior: 'allow', updatedInput: { pattern: '**/*.ts', path: repo } });
    expect(await can('Read', { file_path: '.env' })).toMatchObject({ behavior: 'deny' });
    expect(await can('Edit', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'deny' });
    vi.restoreAllMocks();
  });

  it('a Grep result naming a protected file is withheld; others pass untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const post = postHook(await optionsFor(repo));
    const leaked = await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, '.env')}:1:TOKEN=dummy` } });
    expect(leaked).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { content: expect.stringMatching(/withheld/) } } });
    expect(JSON.stringify(leaked)).not.toContain('dummy');
    expect(await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, 'src', 'a.ts')}:1:export` } })).toEqual({});
    expect(await post({ tool_name: 'Read', tool_response: { file: {} } })).toEqual({});
    vi.restoreAllMocks();
  });

  it('a stored bot secret in a Read or Grep result reaches the model as its marker', async () => {
    const { setRedactedSecrets, __resetRedactedSecretsForTesting } = await import('../../factory/secretRedaction');
    setRedactedSecrets([{ name: 'NPM_TOKEN', value: 'npm_AbCdEf123456789xyz' }]);
    try {
      const post = postHook(await optionsFor(repo));
      const read = await post({ tool_name: 'Read', tool_response: { type: 'text', file: { filePath: path.join(repo, 'config.json'), content: '{"token":"npm_AbCdEf123456789xyz"}' } } });
      expect(read).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { file: { content: '{"token":"[secret:NPM_TOKEN]"}' } } } });
      const grep = await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, 'src', 'a.ts')}:1:npm_AbCdEf123456789xyz` } });
      expect(JSON.stringify(grep)).not.toContain('npm_AbCdEf123456789xyz');
      expect(JSON.stringify(grep)).toContain('[secret:NPM_TOKEN]');
      // Nothing stored in it: the result passes untouched.
      expect(await post({ tool_name: 'Read', tool_response: { file: { content: 'plain' } } })).toEqual({});
    } finally {
      __resetRedactedSecretsForTesting();
    }
  });

  it('without a repository the bot keeps no built-in tools and no hooks', async () => {
    const o = await optionsFor(undefined);
    expect(o.tools).toEqual([]);
    expect(o.hooks).toBeUndefined();
    expect(o.settings).toBeUndefined();
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
  });
});

// ── ACP ─────────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  sessionParams: Array<Record<string, unknown>> = [];
  stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      queueMicrotask(() => {
        if (msg.method === 'session/new') {
          const servers = msg.params.mcpServers as Array<{ args: string[] }>;
          const file = botTokenFileArgValue(servers[0].args) ?? '';
          this.sessionParams.push({ ...msg.params, tokenAtSpawn: fs.readFileSync(file, 'utf8') });
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-bot' } });
        } else if (msg.method === 'initialize') {
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/prompt') {
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      return true;
    },
  };
  emitLine(obj: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

describe('AcpBrainAdapter bot mode', () => {
  it('passes the bot args and token file per session, no token env, cwd = the bot folder', async () => {
    const child = new FakeChild();
    const adapter = new AcpBrainAdapter({
      spawnSpec: { command: 'hermes', args: ['acp'] },
      newSessionSettleMs: 0,
      mcpBundlePath: '/app/dist/mcp-bundle/index.js',
      bot: { binding: BINDING, cwd: dir, wmuxDir: dir },
      spawnFn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    adapter.start({ systemPrompt: 'BOT' });
    const events = await collect(adapter.send('wake'));
    expect(events.at(-1)?.type).toBe('turn-end');
    const params = child.sessionParams[0];
    expect(params.cwd).toBe(dir);
    const server = (params.mcpServers as Array<{ command: string; args: string[]; env: Array<{ name: string }> }>)[0];
    expect(server.command).toBe(process.execPath);
    expect(botArgValue(server.args)).toBe('verifier');
    expect(server.env.map((e) => e.name).filter((n) => n !== 'WMUX_DATA_SUFFIX')).toEqual(['ELECTRON_RUN_AS_NODE']);
    expect(botTokenBinding(params.tokenAtSpawn)).toEqual(BINDING);
    adapter.dispose();
    expect(isCommanderToken(params.tokenAtSpawn)).toBe(false);
  });
});
