// @vitest-environment jsdom
//
// The wizard's "Agent ready" step: with no agent ready the Claude card's
// action is the single primary and the footer says Later; Install shows the
// exact line and runs nothing until Run; once a setup tab is open the dialog
// steps aside to the corner card, and "Back to setup" brings it back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const tab = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../utils/accountLogin', () => ({ openTerminalTab: tab.open }));

import FirstRunWizard from '../FirstRunWizard';
import { resetAgentSetupForTests } from '../../utils/agentSetupRuns';
import type { AgentSetupStatus } from '../../../shared/agentSetup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const notInstalled = (agent: 'claude' | 'codex'): AgentSetupStatus => ({
  agent, readiness: 'not-installed', executable: null, version: null, updateRecommended: false, loginKnown: true,
  candidates: [`/home/u/.local/bin/${agent}`],
});
const ready = (agent: 'claude' | 'codex'): AgentSetupStatus => ({
  agent, readiness: 'ready', executable: `/home/u/.local/bin/${agent}`, version: '9.9.9', updateRecommended: false, loginKnown: true, candidates: [],
});

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

function installBridge(statuses: AgentSetupStatus[]) {
  const firstRun = {
    check: vi.fn().mockResolvedValue({ shown: false, status: { claudeFound: false, mcpRegistered: false, claudeJsonPath: '' } }),
    reopen: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    registerMcp: vi.fn(),
    startSampleTask: vi.fn(),
    onSampleTaskReady: vi.fn(() => () => undefined),
    onSampleTaskTimeout: vi.fn(() => () => undefined),
    agentStatus: vi.fn().mockResolvedValue(statuses),
    agentPlan: vi.fn().mockResolvedValue({
      agent: 'claude',
      install: { command: INSTALL, shell: 'user', officialPage: 'https://code.claude.com/docs/en/setup', missing: [] },
      login: null,
    }),
    setAgentPath: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    firstRun,
    pty: { onData: vi.fn(() => () => undefined), onExit: vi.fn(() => () => undefined) },
  };
  return firstRun;
}

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const primaries = () => Array.from(container.querySelectorAll('.ui-btn-primary')) as HTMLButtonElement[];

beforeEach(() => {
  resetAgentSetupForTests();
  tab.open.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentSetupForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FirstRunWizard agent ready step', () => {
  it('no agent ready: Claude Install is the single primary and the footer says Later', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex')]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(primaries().map((b) => b.dataset.testid)).toEqual(['first-run-agent-claude-install']);
    expect(byId('first-run-wizard-skip')?.textContent).toBe('Later');
    // The old "not detected → claude.ai/code" row is replaced by the card.
    expect(byId('first-run-wizard-claude-missing')).toBeNull();
  });

  it('one agent ready is enough: no agent primary, the footer keeps its usual label', async () => {
    installBridge([notInstalled('claude'), ready('codex')]);
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();
    expect(primaries().map((b) => b.dataset.testid)).not.toContain('first-run-agent-claude-install');
    expect(byId('first-run-wizard-skip')?.textContent).not.toBe('Later');
    expect(byId('first-run-agent-codex')?.dataset.status).toBe('ok');
  });

  it('Install shows the exact line and runs nothing until Run; then the dialog steps aside', async () => {
    installBridge([notInstalled('claude'), notInstalled('codex')]);
    tab.open.mockResolvedValue({ workspaceId: 'ws-1', ptyId: 'pty-1' });
    await act(async () => { root.render(createElement(FirstRunWizard, { mode: 'firstRun', onClose: vi.fn() })); });
    await settle();

    await act(async () => { byId('first-run-agent-claude-install')?.click(); });
    await settle();
    expect(byId('first-run-agent-claude-command')?.textContent).toBe(INSTALL);
    expect(tab.open).not.toHaveBeenCalled();

    await act(async () => { byId('first-run-agent-claude-run')?.click(); });
    await settle();
    expect(tab.open).toHaveBeenCalledWith(expect.objectContaining({ initialCommand: INSTALL, plainEnv: true }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(byId('first-run-agent-corner')).not.toBeNull();

    await act(async () => { byId('first-run-agent-corner-back')?.click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(byId('first-run-agent-claude')?.textContent).toContain('Installing');
  });
});
