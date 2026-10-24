// "Continue in another agent" (#4): a new tab in the held pane, the handoff
// pasted once the agent shows its prompt, never submitted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalTab = vi.fn();
vi.mock('../accountLogin', () => ({ openTerminalTab: (...a: unknown[]) => openTerminalTab(...a) }));
type FakeTerm = { modes: { bracketedPasteMode: boolean }; focus: () => void; screen: string[]; rows: number; buffer: unknown };
const registry = vi.hoisted(() => new Map<string, FakeTerm>());
vi.mock('../../hooks/useTerminal', () => ({ terminalRegistry: registry }));

import { useStore } from '../../stores';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { HANDOFF_FILES_MAX, HANDOFF_REPLY_MAX, HANDOFF_REQUEST_MAX, continueInAgent, continueInAgentText, unsentDraftOf } from '../continueInAgent';
import { everyAccountOutUntil } from '../../components/Pane/usageLimitPresentation';

const write = vi.fn();
const snapshot = vi.fn();
const diffRead = vi.fn();

beforeEach(() => {
  openTerminalTab.mockReset();
  write.mockReset();
  snapshot.mockReset();
  diffRead.mockReset();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('electronAPI', { pty: { write }, chat: { snapshot }, diff: { read: diffRead } });
  useStore.setState({ surfaceAgent: {}, toasts: [], surfaceGitBranch: {}, resumeBindingByPtyId: {} } as never);
  registry.clear();
  registry.set('pty-new', fakeTerm(['› Ask anything']));
});

/** An xterm whose visible screen is `screen` (mutable). */
function fakeTerm(screen: string[]): FakeTerm {
  const term: FakeTerm = {
    modes: { bracketedPasteMode: true },
    focus: () => undefined,
    screen,
    rows: 24,
    buffer: { active: { baseY: 0, getLine: (y: number) => ({ translateToString: () => term.screen[y] ?? '' }) } },
  };
  return term;
}

/** codex-cli 0.157's folder-trust screen. */
const CODEX_TRUST = ['Folder access', '', 'Trust this folder?', '/work/repo', '', '› 1. Trust and continue', '  2. Quit', '', 'Press enter to continue'];
/** Claude Code 2.1.260's folder-trust screen. */
const CLAUDE_TRUST = [
  'Accessing workspace:', '/work/repo', '',
  'Quick safety check: Is this a project you created or one you trust?',
  "Claude Code'll be able to read, edit, and execute files here.", '',
  '❯ 1. No, exit', '  2. Yes, I trust this folder', '',
  'Enter to confirm · Esc to cancel',
];
/** Claude Code's first-run theme picker. */
const CLAUDE_THEME = ['Choose the text style that looks best with your terminal', '', '❯ 1. Dark mode', '  2. Light mode', '', 'Enter to confirm'];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the handoff note', () => {
  it('names who stopped and quotes the last request, capped', () => {
    expect(continueInAgentText('Claude Code', null)).toBe('Claude Code stopped at its usage limit. Please carry on with the work in this folder.');
    const long = 'x'.repeat(HANDOFF_REQUEST_MAX + 10);
    const text = continueInAgentText('Claude Code', { requests: [`  ${long}  `] });
    expect(text).toContain('\n\nThe last request was:\n');
    expect(text.endsWith(`${'x'.repeat(HANDOFF_REQUEST_MAX)}…`)).toBe(true);
  });
});

describe('the handoff memo', () => {
  const facts = {
    requests: ['set up the billing page', 'add the invoice table', 'use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'paginate it', 'fix the empty state'],
    reply: `${'y'.repeat(HANDOFF_REPLY_MAX)} done; pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
    planFiles: ['/home/me/.claude/plans/billing.md'],
    branch: 'feat/billing',
    files: Array.from({ length: HANDOFF_FILES_MAX + 2 }, (_, i) => ({ path: `src/f${i}.ts`, additions: i, deletions: 1 })),
    transcriptPath: '/home/me/.claude/projects/repo/1234.jsonl',
    draft: 'also add CSV export',
  };

  it('carries the first and latest requests, the reply end, plans, git state and transcript, with keys masked', () => {
    const memo = continueInAgentText('Claude Code', facts);
    expect(memo).toContain('The first request was:\nset up the billing page');
    expect(memo).toContain('The latest requests were:\n1. use the key [redacted]\n2. paginate it\n3. fix the empty state');
    expect(memo).not.toContain('add the invoice table');
    expect(memo).not.toContain('sk-ant-');
    expect(memo).toContain("The end of Claude Code's last reply:\n…");
    expect(memo).toContain('done; pushed with [redacted]');
    expect(memo).toContain('Plan and todo files:\n/home/me/.claude/plans/billing.md');
    expect(memo).toContain('Branch: feat/billing\nUncommitted changes (git diff --stat):\n src/f0.ts | +0 -1');
    expect(memo).toContain(' …and 2 more\nCheck the current changes first, then continue.');
    expect(memo).toContain('The original conversation: /home/me/.claude/projects/repo/1234.jsonl');
    // The draft only when the owner chose to carry it.
    expect(memo).not.toContain('also add CSV export');
    expect(continueInAgentText('Claude Code', facts, { carryDraft: true }).endsWith('A draft that was never sent:\nalso add CSV export')).toBe(true);
  });

  it('reads the draft from the input row, leaving dimmed suggestion text out', () => {
    const cell = (ch: string, dim = false) => ({ getWidth: () => 1, getChars: () => ch, isDim: () => (dim ? 1 : 0) });
    const row = (typed: string, ghost: string) => [...`│ > ${typed}`].map((c) => cell(c)).concat([...ghost].map((c) => cell(c, true)), [cell('│')]);
    let cells = row('ship the fix', '');
    registry.set('pty-held', { buffer: { active: { baseY: 0, cursorY: 3, getLine: (y: number) => (y === 3 ? { length: cells.length, getCell: (x: number) => cells[x] } : undefined) } } } as never);
    expect(unsentDraftOf('pty-held')).toBe('ship the fix');
    cells = row('', 'Try "fix lint errors"');
    expect(unsentDraftOf('pty-held')).toBeNull();
  });
});

describe('continueInAgent', () => {
  const req = { heldPtyId: 'pty-held', fromAgent: 'Claude Code', agent: 'codex' as const, workspaceId: 'ws-1', paneId: 'pane-1', cwd: '/repo' };

  it('opens the agent in that pane, waits for its prompt, then pastes the note with no Enter', async () => {
    snapshot.mockResolvedValue({ events: [{ kind: 'user_text', text: 'fix the login bug' }, { kind: 'assistant_text', text: 'on it' }] });
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    const done = continueInAgent(req);
    await vi.waitFor(() => expect(openTerminalTab).toHaveBeenCalled(), { timeout: 5_000 });
    expect(openTerminalTab).toHaveBeenCalledWith({ initialCommand: 'codex', title: 'Codex CLI', cwd: '/repo', target: { workspaceId: 'ws-1', paneId: 'pane-1' } });
    // Still starting: nothing typed yet.
    useStore.setState({ surfaceAgent: { 'pty-new': { name: 'codex', status: 'running', slug: 'codex' } } } as never);
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    useStore.setState({ surfaceAgent: { 'pty-new': { name: 'codex', status: 'idle', slug: 'codex' } } } as never);
    expect(await done).toBe(true);
    const typed = write.mock.calls.map((c) => c[1]).join('');
    expect(typed).toContain('fix the login bug');
    expect(typed.startsWith('\x1b[200~')).toBe(true);
    expect(typed.endsWith('\x1b[201~')).toBe(true);
    expect(typed).not.toMatch(/\r$/);
  });

  const ready = () => useStore.setState({ surfaceAgent: { 'pty-new': { name: 'codex', status: 'idle', slug: 'codex' } } } as never);

  it('a terminal not taking a bracketed paste gets nothing typed, even with the prompt up', async () => {
    snapshot.mockResolvedValue({ events: [{ kind: 'user_text', text: 'line one\nline two' }] });
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    ready();
    registry.get('pty-new')!.modes.bracketedPasteMode = false;
    expect(await continueInAgent(req, 600)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    // No terminal at all: the same.
    registry.clear();
    expect(await continueInAgent(req, 20)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Codex CLI did not show its prompt, so nothing was typed into it.');
  });

  it('waits for the terminal to turn bracketed paste on after the prompt is up', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    ready();
    registry.get('pty-new')!.modes.bracketedPasteMode = false;
    const done = continueInAgent(req, 5_000);
    setTimeout(() => { registry.get('pty-new')!.modes.bracketedPasteMode = true; }, 300);
    expect(await done).toBe(true);
    expect(write.mock.calls.map((c) => c[1]).join('').startsWith('\x1b[200~')).toBe(true);
  });

  it('Codex\'s trust screen with the pane reading idle and bracketed paste on gets no paste, and the owner is told', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    registry.get('pty-new')!.screen = CODEX_TRUST;
    ready();
    expect(await continueInAgent(req, 600)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Codex CLI did not show its prompt, so nothing was typed into it.');
  });

  it('pastes into Codex only once its real prompt replaces the trust screen', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    const term = registry.get('pty-new')!;
    term.screen = CODEX_TRUST;
    ready();
    const done = continueInAgent(req, 5_000);
    await deliberateSleep(400, 'a negative check: still nothing typed while the launch screen is up');
    expect(write).not.toHaveBeenCalled();
    term.screen = ['>_ OpenAI Codex (v0.157.0)', '', '› Ask Codex to do anything'];
    expect(await done).toBe(true);
    expect(write).toHaveBeenCalled();
  });

  it('Claude Code as the target: its trust and first-run screens get no paste; its prompt does', async () => {
    const toClaude = { ...req, fromAgent: 'Codex CLI', agent: 'claude' as const };
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    useStore.setState({ surfaceAgent: { 'pty-new': { name: 'Claude Code', status: 'idle', slug: 'claude' } } } as never);
    const term = registry.get('pty-new')!;
    for (const screen of [CLAUDE_TRUST, CLAUDE_THEME]) {
      term.screen = screen;
      expect(await continueInAgent(toClaude, 400)).toBe(false);
      expect(write).not.toHaveBeenCalled();
    }
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Claude Code did not show its prompt, so nothing was typed into it.');
    term.screen = CLAUDE_THEME;
    const done = continueInAgent(toClaude, 5_000);
    await deliberateSleep(400, 'a negative check: still nothing typed while the launch screen is up');
    expect(write).not.toHaveBeenCalled();
    term.screen = ['╭───────────────────────────╮', '│ ✻ Welcome to Claude Code! │', '╰───────────────────────────╯', '', '❯ ', '', '? for shortcuts'];
    expect(await done).toBe(true);
    expect(openTerminalTab).toHaveBeenLastCalledWith(expect.objectContaining({ initialCommand: 'claude', title: 'Claude Code' }));
    expect(write.mock.calls.map((c) => c[1]).join('')).toContain('Codex CLI stopped at its usage limit.');
  });

  it('a confirm or trust dialog is not the prompt', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    useStore.setState({ surfaceAgent: { 'pty-new': { name: 'codex', status: 'awaiting_input', slug: 'codex' } } } as never);
    expect(await continueInAgent(req, 20)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('a second click while one handoff waits opens no second tab', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    const first = continueInAgent(req, 5_000);
    expect(await continueInAgent(req, 5_000)).toBe(false);
    ready();
    expect(await first).toBe(true);
    expect(openTerminalTab).toHaveBeenCalledTimes(1);
  });

  it('builds the memo from the whole conversation and the folder, and types it without Enter', async () => {
    snapshot.mockImplementation(async (_id: string, before?: number) => (before === undefined
      ? { events: [
        { kind: 'user_text', text: 'now add tests' },
        { kind: 'tool_use', name: 'Write', input: { inline: '{"file_path":"/repo/docs/todo.md","content":"- tests"}' } },
        { kind: 'assistant_text', text: 'Tests are half done.' },
      ], cursor: { headOffset: 500 }, hasMore: true }
      : { events: [{ kind: 'user_text', text: 'build the login page' }], cursor: { headOffset: 0 }, hasMore: false }));
    diffRead.mockResolvedValue({ ok: true, numstat: [{ path: 'src/login.ts', additions: 12, deletions: 3 }], snapshot: { targetBranch: 'feat/login' } });
    useStore.setState({ resumeBindingByPtyId: { 'pty-held': { transcriptPath: '/t/abc.jsonl' } } } as never);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    ready();
    expect(await continueInAgent(req)).toBe(true);
    expect(diffRead).toHaveBeenCalledWith('/repo', '', 'workspace');
    const typed = write.mock.calls.map((c) => c[1]).join('');
    for (const part of ['The first request was:\nbuild the login page', '1. now add tests', 'Tests are half done.', '/repo/docs/todo.md',
      'Branch: feat/login', ' src/login.ts | +12 -3', 'Check the current changes first', 'The original conversation: /t/abc.jsonl']) {
      expect(typed).toContain(part);
    }
    expect(typed.endsWith('\x1b[201~')).toBe(true);
    expect(typed).not.toContain('\r');
  });

  it('quotes the owner\'s request, not wmux\'s own continue message', async () => {
    snapshot.mockResolvedValue({ events: [
      { kind: 'user_text', text: 'fix the login bug' },
      { kind: 'user_text', text: 'Continue from where you left off.' },
    ] });
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    ready();
    expect(await continueInAgent(req)).toBe(true);
    const typed = write.mock.calls.map((c) => c[1]).join('');
    expect(typed).toContain('fix the login bug');
    expect(typed).not.toContain('Continue from where you left off.');
  });

  it('an agent that never shows its prompt gets nothing typed, and the owner is told', async () => {
    snapshot.mockResolvedValue(null);
    openTerminalTab.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-new' });
    expect(await continueInAgent(req, 20)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Codex CLI did not show its prompt, so nothing was typed into it.');
  });
});

describe('everyAccountOutUntil', () => {
  const out = (id: string, at: number | null) => ({ accountId: id, vendor: 'claude', verdict: { usable: false, remaining: 0, availableAtMs: at } });
  it('the earliest reopen when every account is out; nothing while one has quota or with no readings', () => {
    expect(everyAccountOutUntil([out('a', 5_000), out('b', 3_000)], 'claude', 1_000)).toBe(3_000);
    expect(everyAccountOutUntil([out('a', null), out('b', null)], 'claude', 1_000)).toBeNull();
    expect(everyAccountOutUntil([out('a', 5_000), { accountId: 'b', vendor: 'claude', verdict: { usable: true, remaining: 0.5, availableAtMs: null } }], 'claude', 1_000)).toBeUndefined();
    expect(everyAccountOutUntil([out('a', 5_000)], 'codex', 1_000)).toBeUndefined();
    expect(everyAccountOutUntil([], 'claude', 1_000)).toBeUndefined();
  });
});
