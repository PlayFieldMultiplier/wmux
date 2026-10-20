import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../stores', () => ({ useStore: { getState: () => store.state } }));
const tail = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../terminalTail', () => ({ readPtyBufferTail: () => tail.lines }));

import {
  getAgentSetupState,
  resetAgentSetupForTests,
  RUN_TICK_MS,
  DETECT_EVERY_TICKS,
  scanCommandEnd,
  showAgentRunPane,
  startAgentRun,
} from '../agentSetupRuns';
import type { AgentSetupStatus } from '../../../shared/agentSetup';
import type { AgentSetupPlan } from '../../../shared/agentInstall';

const C = '\x1b]133;C\x07';
const D = (n: number) => `\x1b]133;D;${n}\x07\x1b]133;A\x07`;

function status(readiness: AgentSetupStatus['readiness']): AgentSetupStatus[] {
  return [
    { agent: 'claude', readiness, executable: readiness === 'not-installed' ? null : '/u/.local/bin/claude', version: null, updateRecommended: false, loginKnown: true, candidates: [] },
    { agent: 'codex', readiness: 'not-installed', executable: null, version: null, updateRecommended: false, loginKnown: true, candidates: [] },
  ];
}

const plan: AgentSetupPlan = {
  agent: 'claude',
  install: { command: 'curl -fsSL https://claude.ai/install.sh | bash', shell: 'user', officialPage: 'https://code.claude.com/docs/en/setup', missing: [] },
  login: { command: "'/u/.local/bin/claude'", shell: 'user' },
};

function setup() {
  const surfaces: Array<{ id: string; ptyId: string }> = [];
  const ws = { id: 'ws-1', activePaneId: 'pane-1', rootPane: { type: 'leaf', id: 'pane-1', surfaces } };
  let onData: ((id: string, data: string, replay: boolean) => void) | null = null;
  let onExit: ((id: string, code: number) => void) | null = null;
  let current = status('not-installed');
  const pty = {
    create: vi.fn(async () => ({ id: 'pty-setup', shell: '/bin/zsh', cwd: '/u' })),
    dispose: vi.fn(async () => undefined),
    onData: vi.fn((cb: typeof onData) => { onData = cb; return () => { onData = null; }; }),
    onExit: vi.fn((cb: typeof onExit) => { onExit = cb; return () => { onExit = null; }; }),
  };
  store.state = {
    paneGate: 'ready', activeWorkspaceId: 'ws-1', workspaces: [ws], startupDirectory: '', defaultShell: '',
    addSurface: vi.fn((_p: string, ptyId: string) => { surfaces.push({ id: 'surf-setup', ptyId }); }),
    updateSurfaceTitle: vi.fn(), setActivePane: vi.fn(), setSettingsPanelVisible: vi.fn(), pushToast: vi.fn(),
    setActiveWorkspace: vi.fn(), setActiveSurface: vi.fn(),
  };
  const agentStatus = vi.fn(async () => current);
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { pty, firstRun: { agentStatus } } };
  return {
    pty, surfaces, agentStatus,
    setStatus: (s: AgentSetupStatus[]) => { current = s; },
    data: (d: string) => onData?.('pty-setup', d, false),
    exit: () => onExit?.('pty-setup', 0),
  };
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('scanCommandEnd', () => {
  it('ignores the first prompt\'s command-end and reads the exit after a command start', () => {
    expect(scanCommandEnd(`${D(0)}`, false)).toMatchObject({ started: false, ended: false, exitCode: null });
    expect(scanCommandEnd(`${D(0)}${C}output${D(7)}`, false)).toMatchObject({ started: true, ended: true, exitCode: 7 });
    expect(scanCommandEnd(`more${D(0)}`, true)).toMatchObject({ started: true, ended: true, exitCode: 0 });
  });

  it('waits for the terminator, across any number of chunks', () => {
    // `ESC]133;D` alone is not a finished mark: its exit code may still be coming.
    let r = scanCommandEnd(`${C}out\x1b]133;`, false);
    expect(r).toMatchObject({ started: true, ended: false });
    r = scanCommandEnd(`${r.rest}D`, r.started);
    expect(r.ended).toBe(false);
    r = scanCommandEnd(`${r.rest};6`, r.started);
    expect(r.ended).toBe(false);
    r = scanCommandEnd(`${r.rest}\x07`, r.started);
    expect(r).toMatchObject({ ended: true, exitCode: 6 });
  });
});

describe('startAgentRun', () => {
  beforeEach(() => { vi.useFakeTimers(); resetAgentSetupForTests(); tail.lines = []; });
  afterEach(() => { resetAgentSetupForTests(); vi.useRealTimers(); });

  it('types the confirmed line into a visible tab and succeeds when the agent then shows up', async () => {
    const h = setup();
    const run = await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    expect(run.phase).toBe('running');
    // Exactly the bundled line, typed into the user's own shell (no shell override, no env).
    expect(h.pty.create).toHaveBeenCalledWith(expect.objectContaining({ initialCommand: plan.install.command }));
    const opts = (h.pty.create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts.shell).toBeUndefined();
    expect(opts.env).toBeUndefined();
    // Not the workspace's bound account either: the pane must match what detection reads.
    expect(opts.ignoreAccountBinding).toBe(true);

    h.setStatus(status('login-needed'));
    h.data(`${C}installing...${D(0)}`);
    await flush();
    expect(getAgentSetupState().runs.claude?.phase).toBe('succeeded');
  });

  it('reports a network failure from the pane when the line exits non-zero', async () => {
    const h = setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    tail.lines = ['curl: (6) Could not resolve host: claude.ai'];
    h.data(`${C}${D(6)}`);
    await flush();
    expect(getAgentSetupState().runs.claude).toMatchObject({ phase: 'failed', failure: 'network' });
  });

  it('a download that failed inside `curl | sh` still reads as a failure though the line exits 0', async () => {
    const h = setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    tail.lines = ['curl: (6) Could not resolve host: claude.ai'];
    h.data(`${C}${D(0)}`);
    await flush();
    expect(getAgentSetupState().runs.claude).toMatchObject({ phase: 'failed', failure: 'network' });
  });

  it('a late end of an earlier run never changes the run that replaced it', async () => {
    const h = setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    let release: () => void = () => undefined;
    h.agentStatus.mockImplementationOnce(() => new Promise((r) => { release = () => r(status('not-installed')); }));
    tail.lines = ['curl: (6) Could not resolve host: claude.ai'];
    h.data(`${C}${D(6)}`); // the first run starts ending, waiting on detection
    await flush();
    const second = await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    release();
    await flush();
    expect(getAgentSetupState().runs.claude).toMatchObject({ id: second.id, phase: 'running' });
  });

  it('a second click while the tab is opening gets the same run, not a second tab', async () => {
    const h = setup();
    const [a, b] = await Promise.all([
      startAgentRun('claude', 'install', plan, 'Install Claude Code'),
      startAgentRun('claude', 'install', plan, 'Install Claude Code'),
    ]);
    expect(h.pty.create).toHaveBeenCalledTimes(1);
    expect(a.id).toBe(b.id);
  });

  it('judges a finished install by a detection round that started after it finished', async () => {
    const h = setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    // A poll starts while the installer is still running and answers late.
    let release: () => void = () => undefined;
    h.agentStatus.mockImplementationOnce(() => new Promise((r) => { release = () => r(status('not-installed')); }));
    await vi.advanceTimersByTimeAsync(RUN_TICK_MS * DETECT_EVERY_TICKS);
    h.setStatus(status('login-needed'));
    h.data(`${C}${D(0)}`);
    release();
    await flush();
    await flush();
    expect(getAgentSetupState().runs.claude?.phase).toBe('succeeded');
  });

  it('"View log" brings the run\'s own tab to the front', async () => {
    setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    expect(showAgentRunPane('claude')).toBe(true);
    const st = store.state as Record<string, ReturnType<typeof vi.fn>>;
    expect(st.setActiveSurface).toHaveBeenCalledWith('pane-1', 'surf-setup', 'ws-1');
  });

  it('says "not found" when the installer finished but detection still misses it', async () => {
    const h = setup();
    await startAgentRun('claude', 'install', plan, 'Install Claude Code');
    h.data(`${C}${D(0)}`);
    await flush();
    expect(getAgentSetupState().runs.claude?.phase).toBe('not-found');
  });

  it('a sign-in turns ready from polling, and closing the pane first means "log in again"', async () => {
    const h = setup();
    h.setStatus(status('login-needed'));
    await startAgentRun('claude', 'login', plan, 'Sign in to Claude Code');
    expect(h.pty.create).toHaveBeenCalledWith(expect.objectContaining({ initialCommand: plan.login?.command }));

    h.setStatus(status('ready'));
    await vi.advanceTimersByTimeAsync(RUN_TICK_MS * DETECT_EVERY_TICKS);
    await flush();
    expect(getAgentSetupState().runs.claude?.phase).toBe('succeeded');

    h.setStatus(status('login-needed'));
    await startAgentRun('claude', 'login', plan, 'Sign in to Claude Code');
    h.exit();
    await flush();
    expect(getAgentSetupState().runs.claude?.phase).toBe('closed');
  });

  it('shows the guide card for the Claude screen on the sign-in pane', async () => {
    const h = setup();
    h.setStatus(status('login-needed'));
    await startAgentRun('claude', 'login', plan, 'Sign in to Claude Code');
    tail.lines = ['Do you trust the files in this folder?', '❯ 1. Yes, I trust this folder', '  2. No, exit'];
    await vi.advanceTimersByTimeAsync(RUN_TICK_MS);
    expect(getAgentSetupState().runs.claude?.screen).toBe('folder-trust');
  });
});
