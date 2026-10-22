// @vitest-environment jsdom
// The usage-limit card (#4): opened by itself once for the pane in front,
// resume automatically on by default, another account only with 2+, the
// opt-in "Always switch automatically", another agent only when it is ready.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/continueInAgent', () => ({ continueInAgent: vi.fn(async () => true) }));

import { useStore } from '../../../stores';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';
import { continueInAgent } from '../../../utils/continueInAgent';
import UsageLimitChip from '../UsageLimitChip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
let container: HTMLDivElement;
let root: Root;
let detectedAt = 1_000;
const update = vi.fn(async () => ({ ok: true }));
const rotationSet = vi.fn(async () => ({ ok: true }));

function stubApi(opts: { accounts?: number; codex?: 'ready' | 'login-needed'; rotation?: { claude: boolean; rows?: unknown[] } } = {}) {
  const accounts = Array.from({ length: opts.accounts ?? 2 }, (_, i) => ({ id: `acc-${i}`, name: `Account ${i}`, vendor: 'claude', status: { loggedIn: true } }));
  vi.stubGlobal('electronAPI', {
    usageLimit: { update },
    accounts: { list: vi.fn(async () => ({ accounts, bindings: {} })), continuePane: vi.fn(async () => ({ ok: true })) },
    accountRotation: {
      get: vi.fn(async () => ({ settings: { claude: opts.rotation?.claude ?? false, codex: false }, rows: opts.rotation?.rows ?? [] })),
      set: rotationSet,
    },
    firstRun: { agentStatus: vi.fn(async () => [{ agent: 'claude', readiness: 'ready' }, { agent: 'codex', readiness: opts.codex ?? 'ready' }]) },
  });
}

function hold(over: Record<string, unknown> = {}) {
  detectedAt += 1;
  useStore.setState({
    usageLimits: { 'pty-1': { ptyId: 'pty-1', provider: 'claude', detectedAt, resetsAt: Date.now() + 2 * HOUR, source: 'hook', autoResume: true, ...over } },
  } as never);
}

async function render(paneInFront = true) {
  useStore.setState({
    activeWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1', name: 'W', activePaneId: paneInFront ? 'pane-1' : 'pane-2' }],
    surfaceAgent: { 'pty-1': { name: 'claude', status: 'idle', slug: 'claude' } },
  } as never);
  await act(async () => root.render(<UsageLimitChip ptyId="pty-1" compact={false} workspaceId="ws-1" paneId="pane-1" cwd="/repo" />));
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

const card = () => document.querySelector<HTMLElement>('[data-usage-limit-card]');
const q = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel);

beforeEach(() => {
  update.mockClear();
  rotationSet.mockClear();
  vi.mocked(continueInAgent).mockClear();
  setDaemonModeActive(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDaemonModeForTests();
  vi.unstubAllGlobals();
});

describe('usage-limit card', () => {
  it('opens by itself once for the pane in front, never for a pane behind; the chip toggles it', async () => {
    stubApi();
    hold();
    await render(false);
    expect(card()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    hold();
    await render(true);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('Usage limit reached');
    // Closed, it stays closed for this limit; the chip opens it again.
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(card()).toBeNull();
    // The same limit drawn again (a tab switch remounts the chip): no reopen.
    act(() => root.unmount());
    root = createRoot(container);
    await render(true);
    expect(card()).toBeNull();
    await act(async () => q('[data-usage-limit-action="card"]')!.click());
    expect(card()).not.toBeNull();
  });

  it('resume automatically shows the pane\'s armed state and changes it', async () => {
    stubApi();
    hold({ autoResume: true });
    await render();
    const sw = q<HTMLButtonElement>('[data-usage-limit-card-action="auto-resume"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    expect(update).toHaveBeenCalledWith('pty-1', { autoResume: false });
  });

  it('another account: listed only with 2+ accounts; Always switch turns on switch-by-quota', async () => {
    stubApi({ accounts: 1 });
    hold();
    await render();
    expect(q('[data-testid="usage-limit-card-accounts"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    stubApi({ accounts: 2 });
    hold();
    await render();
    expect(document.querySelectorAll('[data-usage-limit-card-account]')).toHaveLength(2);
    const always = q<HTMLButtonElement>('[data-usage-limit-card-action="always-switch"]')!;
    expect(always.getAttribute('aria-checked')).toBe('false');
    await act(async () => always.click());
    expect(rotationSet).toHaveBeenCalledWith('claude', true);
  });

  it('another agent: offered only when installed and signed in, and opens it in this pane', async () => {
    stubApi({ codex: 'login-needed' });
    hold();
    await render();
    expect(q('[data-usage-limit-card-agent="codex"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    stubApi({ codex: 'ready' });
    hold();
    await render();
    // Never the agent that is out.
    expect(q('[data-usage-limit-card-agent="claude"]')).toBeNull();
    await act(async () => q('[data-usage-limit-card-agent="codex"]')!.click());
    expect(continueInAgent).toHaveBeenCalledWith({ heldPtyId: 'pty-1', fromAgent: 'Claude Code', agent: 'codex', workspaceId: 'ws-1', paneId: 'pane-1', cwd: '/repo' });
    expect(card()).toBeNull();
  });

  it('every account out: says when the first one reopens', async () => {
    const at = Date.now() + 3 * HOUR;
    stubApi({ rotation: { claude: true, rows: [
      { accountId: 'acc-0', vendor: 'claude', verdict: { usable: false, remaining: 0, availableAtMs: at }, capturedAtMs: 1 },
      { accountId: 'acc-1', vendor: 'claude', verdict: { usable: false, remaining: 0, availableAtMs: at + HOUR }, capturedAtMs: 1 },
    ] } });
    hold();
    await render();
    expect(q('[data-usage-limit-card-all-out]')?.textContent).toMatch(/^Every account is out until /);
  });
});
