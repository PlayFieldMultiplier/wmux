// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useStore } from '../../index';
import { selectFleetBoard, selectFleetSectionCounts, selectLocalAgentsWorking } from '../fleet';
import { ownerFleetState } from '../../../components/Sidebar/botTasks';
import { formatShadowWorkspaceId } from '../../../../shared/pcRail';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';
import type { Workspace } from '../../../../shared/types';

type State = ReturnType<typeof useStore.getState>;

/** The fixture with its one running local agent (pty-3) settled. */
function seedNothingRunning(now: number, extra: Partial<State> = {}): void {
  seedFleetTriageStore(now, {
    surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'waiting' } },
    surfaceTurnOpenAt: {},
    ...extra,
  });
}

describe('selectLocalAgentsWorking (keeps the computer awake)', () => {
  it('is true exactly when Fleet has a local row in Running', () => {
    const now = Date.now();
    seedFleetTriageStore(now);
    expect(selectFleetBoard(useStore.getState(), { now, sortMode: 'attention' }).groups.running.length).toBeGreaterThan(0);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(true);

    seedNothingRunning(now);
    expect(selectFleetSectionCounts(useStore.getState()).running).toBe(0);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);
  });

  it('does not count an agent working on another computer', () => {
    const now = Date.now();
    seedNothingRunning(now, {
      remoteWorkspaces: [{
        key: 'host-1:rw-1', hostId: 'host-1', hostLabel: 'office-mac', workspaceId: 'rw-1', name: 'proj',
        panes: [{ sessionId: 'rsession-9', shell: 'zsh', agentName: 'Codex', agentStatus: 'running' }],
      }] as unknown as State['remoteWorkspaces'],
    });
    // Fleet lists the remote agent as running; this computer has nothing to do.
    expect(selectFleetBoard(useStore.getState(), { now, sortMode: 'attention' }).groups.running.length).toBe(1);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);

    // A PC rail shadow workspace mirrors another computer's panes too.
    const shadowId = formatShadowWorkspaceId('host-2', 'ws-x') as string;
    const shadow: Workspace = {
      id: shadowId, name: 'shadow',
      rootPane: { id: 'ps', type: 'leaf', surfaces: [{ id: 'ss', ptyId: 'pty-s', title: 'claude', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }], activeSurfaceId: 'ss' },
      activePaneId: 'ps',
    };
    useStore.setState({
      workspaces: [...useStore.getState().workspaces, shadow],
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-s': { name: 'Claude Code', status: 'running' } },
      surfaceTurnOpenAt: { 'pty-s': now - 1_000 },
    });
    expect(selectFleetBoard(useStore.getState(), { now, sortMode: 'attention' }).groups.running.length).toBe(2);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);
  });

  it('counts a bot worker, which Fleet leaves to its bot', () => {
    const now = Date.now();
    seedFleetTriageStore(now, {
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'waiting' }, 'pty-3': { name: 'Claude Code', status: 'running' } },
      fanoutOrigin: { 'ws-3': { kind: 'bot', botId: 'bot-1' } },
    });
    expect(selectFleetSectionCounts(ownerFleetState(useStore.getState())).running).toBe(0);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(true);
  });

  it('turns false when the last working agent goes idle', () => {
    const now = Date.now();
    seedFleetTriageStore(now);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(true);
    useStore.setState({
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'waiting' }, 'pty-3': { name: 'Claude Code', status: 'idle' } },
      surfaceTurnOpenAt: {},
    });
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);
  });
});
