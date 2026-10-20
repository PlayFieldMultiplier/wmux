// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentNotReadyRow from '../AgentNotReadyRow';
import { refreshAgentStatus, resetAgentSetupForTests } from '../../../utils/agentSetupRuns';
import { FIRST_RUN_REOPEN_EVENT } from '../../../../shared/firstRun';
import type { AgentSetupStatus } from '../../../../shared/agentSetup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (agent: 'claude' | 'codex', readiness: AgentSetupStatus['readiness']): AgentSetupStatus => ({
  agent, readiness, executable: null, version: null, updateRecommended: false, loginKnown: true, candidates: [],
});

let container: HTMLDivElement;
let root: Root;

async function renderWith(statuses: AgentSetupStatus[]) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { firstRun: { agentStatus: vi.fn().mockResolvedValue(statuses) } };
  await refreshAgentStatus();
  await act(async () => { root.render(createElement(AgentNotReadyRow)); });
}

beforeEach(() => {
  resetAgentSetupForTests();
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

describe('AgentNotReadyRow', () => {
  it('shows while no agent is ready, and reopens the setup wizard', async () => {
    await renderWith([status('claude', 'login-needed'), status('codex', 'not-installed')]);
    const row = container.querySelector('[data-testid="sidebar-agent-not-ready"]') as HTMLButtonElement;
    expect(row?.textContent).toContain('Agent not set up');
    const onReopen = vi.fn();
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, onReopen);
    act(() => row.click());
    window.removeEventListener(FIRST_RUN_REOPEN_EVENT, onReopen);
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it('is gone once one agent is ready, and before anything was checked', async () => {
    await renderWith([status('claude', 'not-installed'), status('codex', 'ready')]);
    expect(container.querySelector('[data-testid="sidebar-agent-not-ready"]')).toBeNull();
    resetAgentSetupForTests();
    await act(async () => { root.render(createElement(AgentNotReadyRow)); });
    expect(container.querySelector('[data-testid="sidebar-agent-not-ready"]')).toBeNull();
  });
});
