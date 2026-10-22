// "Continue in another agent" (#4): a new tab in the held pane, the handoff
// pasted once the agent shows its prompt, never submitted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalTab = vi.fn();
vi.mock('../accountLogin', () => ({ openTerminalTab: (...a: unknown[]) => openTerminalTab(...a) }));
const registry = vi.hoisted(() => new Map<string, { modes: { bracketedPasteMode: boolean }; focus: () => void }>());
vi.mock('../../hooks/useTerminal', () => ({ terminalRegistry: registry }));

import { useStore } from '../../stores';
import { HANDOFF_REQUEST_MAX, continueInAgent, continueInAgentText } from '../continueInAgent';
import { everyAccountOutUntil } from '../../components/Pane/usageLimitPresentation';

const write = vi.fn();
const snapshot = vi.fn();

beforeEach(() => {
  openTerminalTab.mockReset();
  write.mockReset();
  snapshot.mockReset();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('electronAPI', { pty: { write }, chat: { snapshot } });
  useStore.setState({ surfaceAgent: {}, toasts: [] } as never);
  registry.clear();
  registry.set('pty-new', { modes: { bracketedPasteMode: true }, focus: () => undefined });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the handoff note', () => {
  it('names who stopped and quotes the last request, capped', () => {
    expect(continueInAgentText('Claude Code', null)).toBe('Claude Code stopped at its usage limit. Please carry on with the work in this folder.');
    const long = 'x'.repeat(HANDOFF_REQUEST_MAX + 10);
    const text = continueInAgentText('Claude Code', `  ${long}  `);
    expect(text).toContain('\n\nThe last request was:\n');
    expect(text.endsWith(`${'x'.repeat(HANDOFF_REQUEST_MAX)}…`)).toBe(true);
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
