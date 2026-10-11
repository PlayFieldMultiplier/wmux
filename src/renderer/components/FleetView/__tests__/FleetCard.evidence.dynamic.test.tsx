// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetCard from '../FleetCard';
import { useStore } from '../../../stores';
import type { FleetPane } from '../../../stores/selectors/fleet';
import type { Task } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: FleetPane = {
  workspaceId: 'ws-1', workspaceName: 'app', paneId: 'p1', surfaceId: 's1', ptyId: 'pty-1',
  agentStatus: 'complete', title: 'Claude Code', surfaceType: 'terminal', isActivePane: true, unverifiable: false,
};

function task(id: string, state: Task['status']['state'], timestamp: string): Task {
  return {
    kind: 'task', id, history: [], artifacts: [],
    status: { state, timestamp, evidence: { summary: 'Checked the build', items: [
      { kind: 'command', command: 'npm test', summary: 'Tests', status: 'passed' },
    ] } },
    metadata: {
      title: 'Fix login', from: { workspaceId: 'owner', name: 'sender' },
      to: { workspaceId: 'ws-1', paneId: 'p1', name: 'receiver' }, createdAt: timestamp, updatedAt: timestamp,
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useStore.setState(useStore.getInitialState());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState(useStore.getInitialState());
});

describe('Fleet completion evidence updates', () => {
  it('removes stale success on a newer failure and exposes missing or failed checks on the next completion', () => {
    const old = task('old', 'completed', '2026-10-11T01:00:00.000Z');
    act(() => {
      useStore.setState({ a2aTasks: { old } });
      root.render(createElement(FleetCard, { card, focused: true, onJump: () => undefined }));
    });
    const row = container.querySelector('[data-fleet-card]');
    if (!row) throw new Error('Expected the completed agent row');
    const badge = () => container.querySelector('[data-fleet-evidence]');
    expect(badge()?.getAttribute('data-evidence-state')).toBe('verified');
    expect(row.getAttribute('aria-describedby')).toBe(badge()?.id);
    expect(badge()?.getAttribute('aria-label')).toContain('Agent-reported checks');

    const latest = task('latest', 'failed', '2026-10-11T02:00:00.000Z');
    act(() => useStore.setState({ a2aTasks: { old, latest } }));
    expect(badge()).toBeNull();
    expect(row.hasAttribute('aria-describedby')).toBe(false);

    const completed = { ...latest, status: { ...latest.status, state: 'completed' as const, evidence: undefined } };
    act(() => useStore.setState({ a2aTasks: { old, latest: completed } }));
    expect(badge()?.textContent).toContain('No verification reported');

    const mixed: Task = { ...completed, status: { ...completed.status, evidence: {
      summary: 'Build passed but tests failed', items: [
        { kind: 'command', command: 'npm run build', summary: 'Build', status: 'passed' },
        { kind: 'command', command: 'npm test', summary: 'Tests', status: 'failed' },
      ],
    } } };
    act(() => useStore.setState({ a2aTasks: { old, latest: mixed } }));
    expect(badge()?.getAttribute('data-evidence-state')).toBe('failed');
    expect(badge()?.textContent).toContain('Failed checks: 1');
    expect(badge()?.getAttribute('aria-label')).toContain('Failed: npm test');
    expect(badge()?.innerHTML).not.toContain('var(--accent-green)');

    act(() => root.render(createElement(FleetCard, { card: { ...card, agentStatus: 'running' }, focused: true, onJump: () => undefined })));
    expect(badge()).toBeNull();
    expect(row.hasAttribute('aria-describedby')).toBe(false);
  });
});
