// Terminal → chat (fromTerminal): the TUI is stopped and proved gone before a
// chat-v2 driver resumes the same session id, the pane is reserved meanwhile,
// and a failed start drops its record only once that process is proved gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeBinding } from '../../../../shared/agentResume';
import type { ProcessTreeEntry } from '../../../AgentProcessTracker';
import type { AgentStopResult } from '../../../agentStop';
import { continueOnAccount } from '../../../continueOnAccount';
import { ChildBackend } from '../childBackend';
import { ClaudeDriver } from '../claude/claudeDriver';
import { createChatV2Host } from '../host';
import type { ChatV2Host, ChatV2HostDeps, ChatV2TerminalDeps } from '../types';
import { FakeClaude, until } from './fakeClaude';

// The login-shell PATH probe would run the user's real shell. `onExecEnv` lets
// a test act in the gap between the pane check and the spawn.
const execEnvHook = vi.hoisted(() => ({ onExecEnv: null as null | (() => void) }));
vi.mock('../../../../shared/execEnv', () => ({
  agentExecEnv: async (env: NodeJS.ProcessEnv) => {
    execEnvHook.onExecEnv?.();
    return { ...env, PATH: `${env.PATH ?? ''}:/opt/login/bin` };
  },
}));

const PANE = 'pty-tui-1';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-from-')); });
afterEach(() => {
  execEnvHook.onExecEnv = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  host: ChatV2Host;
  fakes: FakeClaude[];
  paneFree: { value: boolean };
  probe: { value: 'gone' | 'exists' | 'unknown' };
  identity: { value: { startTime: string; commandLine: string } | null };
  term: {
    live: string | undefined;
    binding: ResumeBinding | undefined;
    stop: () => Promise<AgentStopResult>;
    stops: number;
    holders: ProcessTreeEntry[];
  };
  configDir: string;
  transcript: string;
}

const TREE = { root: { pid: 7001, ppid: 1, name: 'claude' }, descendants: [{ pid: 7002, ppid: 7001, name: 'node', cmdline: 'node github-mcp-server' }] };

function rig(options: { stubborn?: boolean; paneConfigDir?: string } = {}): Rig {
  const configDir = path.join(dir, 'claude-home');
  const transcript = path.join(configDir, 'projects', '-repo', `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const r = {
    fakes: [] as FakeClaude[],
    paneFree: { value: true },
    probe: { value: 'gone' as const },
    identity: { value: null },
    configDir,
    transcript,
    term: {
      live: 'claude' as string | undefined,
      binding: { agent: 'claude', sessionId: SESSION, cwd: dir, transcriptPath: transcript, permissionMode: 'default', ts: 1 } as ResumeBinding | undefined,
      stops: 0,
      holders: [] as ProcessTreeEntry[],
      stop: async (): Promise<AgentStopResult> => ({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 }),
    },
  } as unknown as Rig;
  const pane = {
    meta: { spawnCwd: dir, incarnationId: 'inc-1', env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: options.paneConfigDir ?? configDir }, cmd: '/bin/zsh' },
    promptLog: { size: 1, isCommandRunning: () => false },
    bridge: { isEmptyShellPrompt: () => true, getInputRevision: () => 1 },
  };
  const terminal: ChatV2TerminalDeps = {
    holdKeyboard: () => () => undefined,
    binding: () => r.term.binding,
    unsupported: () => null,
    liveAgent: () => r.term.live,
    notAtRest: async () => null,
    stillIdle: () => true,
    tree: async () => (r.term.live === 'claude' ? TREE : null),
    stop: async () => {
      r.term.stops += 1;
      const result = await r.term.stop();
      if (result.ok && result.stopped) r.term.live = undefined;
      return result;
    },
    processesWithArg: async () => r.term.holders,
    otherOwners: () => [],
  };
  const deps: ChatV2HostDeps = {
    // Each host its own record store: a second rig in a test must not load the first one's records.
    wmuxDir: fs.mkdtempSync(path.join(dir, 'wmux-')),
    log: () => undefined,
    now: () => 100_000,
    sessionManager: { getSession: ((id: string) => (id === PANE ? pane : undefined)) as unknown as ChatV2HostDeps['sessionManager']['getSession'] },
    approvals: () => null,
    paneFree: async () => r.paneFree.value,
    writeToPane: () => true,
    processProbe: () => r.probe.value,
    sendTo: () => true,
    processIdentity: async () => r.identity.value,
    killTree: async () => undefined,
    terminal,
    claudeOnPath: async () => '/usr/local/bin/claude',
    platform: 'darwin',
    moveTiming: { quietMs: 1, freeWaitMs: 30 },
    drivers: () => {
      const fake = new FakeClaude();
      fake.stubborn = options.stubborn ?? false;
      r.fakes.push(fake);
      return new ClaudeDriver({ settingSources: 'project', command: 'claude', backend: fake.backend() as ChildBackend });
    },
  };
  r.host = createChatV2Host(deps);
  return r;
}

const move = (r: Rig) => r.host.call('fromTerminal', { paneId: PANE }, 'main');

describe('terminal → chat', () => {
  it('stops the TUI, then resumes its exact session id in a chat that has no turn yet', async () => {
    const r = rig();
    const preview = await r.host.call('fromTerminal', { paneId: PANE, preview: true }, 'main');
    expect(preview).toEqual({ ok: true, processes: [{ name: 'node', mcp: true }] });
    expect(r.term.stops).toBe(0);

    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(1);
    expect(res.binding).toMatchObject({ providerSessionId: SESSION, status: 'idle', mode: 'default' });
    const args = r.fakes[0].args;
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', SESSION]);
    expect(args).not.toContain('--session-id');
    expect(r.fakes[0].cwd).toBe(dir);
    expect(r.host.sessionForPane(PANE)!.blocks.some((b) => b.role === 'user')).toBe(false);
    await r.host.dispose();
  });

  it('holds the pane between the stop and the record: create and launches are refused', async () => {
    const r = rig();
    let release!: () => void;
    r.term.stop = () => new Promise((resolve) => { release = () => resolve({ ok: true, stopped: true, pid: TREE.root.pid, killed: 2 }); });
    const pending = move(r);
    await until(() => r.term.stops === 1);
    // The TUI is stopping and no record exists yet: a create would start a fresh `--session-id`.
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(true);
    expect(await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main'))
      .toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    // Continue on another account shares the pane's move lock.
    expect(await continueOnAccount({} as Parameters<typeof continueOnAccount>[0], PANE, '/elsewhere')).toEqual({ ok: false, code: 'busy' });
    expect(await move(r)).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    release();
    expect((await pending).ok).toBe(true);
    expect(r.fakes).toHaveLength(1);
    expect(r.host.ownsPane(PANE)).toBe(true);
    await r.host.dispose();
  });

  it('refuses a stop that found nothing to signal, and a conversation in another account folder', async () => {
    const r = rig();
    r.term.stop = async () => ({ ok: true, stopped: false });
    expect(await move(r)).toMatchObject({ ok: false, error: { message: 'Could not find the Claude process to stop.' } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(false);

    const other = path.join(dir, 'other-account');
    fs.mkdirSync(path.join(other, 'projects'), { recursive: true });
    const s = rig({ paneConfigDir: other });
    expect(await move(s)).toMatchObject({ ok: false, error: { message: 'This conversation belongs to another Claude account folder than this pane uses.' } });
    expect(s.term.stops).toBe(0);

    // A `projects` folder that links to the conversation's is the same folder.
    const linked = path.join(dir, 'linked-account');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(dir, 'claude-home', 'projects'), path.join(linked, 'projects'));
    const t = rig({ paneConfigDir: linked });
    expect((await move(t)).ok).toBe(true);
    await t.host.dispose();
  });

  it('a process holding the session id after the stop keeps the chat from starting', async () => {
    const r = rig();
    r.term.stop = async () => {
      r.term.holders = [{ pid: 9100, ppid: 1, name: 'tail', cmdline: `tail -f ${SESSION}.jsonl` }];
      return { ok: true, stopped: true, pid: TREE.root.pid, killed: 2 };
    };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('Claude was stopped; reopen it with Resume. Another process holds this conversation: tail (pid 9100)') } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
  });

  it('a shell child that appears while the driver starts stops the driver', async () => {
    const r = rig();
    // After the pre-spawn check, before the spawn: `claude` typed into the shell.
    execEnvHook.onExecEnv = () => { if (r.term.stops > 0) r.paneFree.value = false; };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { code: 'handoff-refused', message: expect.stringContaining('Something started in this pane') } });
    expect(r.fakes).toHaveLength(1);
    // Its exit is proved (signal 0: gone), so the record went with it.
    expect(r.host.bindingForPane(PANE)).toBeNull();
    expect(r.host.ownsPane(PANE)).toBe(false);
  });

  it('a failed start keeps the record until the driver’s exit is proved', async () => {
    const r = rig({ stubborn: true });
    r.probe.value = 'exists';
    r.identity.value = { startTime: 'start-1', commandLine: `claude --resume ${SESSION}` };
    execEnvHook.onExecEnv = () => { if (r.term.stops > 0) r.paneFree.value = false; };
    const res = await move(r);
    expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('the chat was kept so wmux can stop it') } });
    // Kept, stopped, still owning the pane: nothing may type a resume into it.
    expect(r.host.bindingForPane(PANE)).toMatchObject({ providerSessionId: SESSION });
    expect(r.host.ownsPane(PANE)).toBe(true);

    // A driver that reported its exit while the OS still shows it: kept too.
    const s = rig();
    s.probe.value = 'exists';
    s.identity.value = { startTime: 'start-1', commandLine: `claude --resume ${SESSION}` };
    execEnvHook.onExecEnv = () => { if (s.term.stops > 0) s.paneFree.value = false; };
    expect(await move(s)).toMatchObject({ ok: false, error: { message: expect.stringContaining('the chat was kept so wmux can stop it') } });
    expect(s.host.bindingForPane(PANE)).toMatchObject({ providerSessionId: SESSION });
  });

  it('a handed-off chat whose TUI already exited comes back under its own id', async () => {
    const r = rig();
    r.term.live = undefined;
    const created = await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main');
    if (!created.ok) throw new Error(created.error.message);
    const handed = await r.host.call('toTerminal', { paneId: PANE, chatSessionId: created.binding.chatSessionId }, 'main');
    expect(handed.ok).toBe(true);
    expect(r.host.ownsPane(PANE)).toBe(false);
    const res = await move(r);
    if (!res.ok) throw new Error(res.error.message);
    expect(r.term.stops).toBe(0);
    expect(res.binding).toMatchObject({ chatSessionId: created.binding.chatSessionId, providerSessionId: SESSION, status: 'idle' });
    expect(res.binding!.epoch).not.toBe(created.binding.epoch);
    expect(r.fakes.at(-1)!.args).toContain('--resume');
    await r.host.dispose();
  });
});
