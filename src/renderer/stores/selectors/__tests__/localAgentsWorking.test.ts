// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useStore } from '../../index';
import { QUIET_TURN_OUTPUT_MS, selectFleetBoard, selectFleetSectionCounts, selectLocalAgentsWorking } from '../fleet';
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

  it('keeps a turn with no hook for 30 min working while its agent is alive and printing', () => {
    const now = Date.now();
    // pty-3's turn opened 30 s before `now`; the clock is past the 30 min mark.
    const clock = now + 31 * 60_000;
    seedFleetTriageStore(now, { agentClockMs: clock, surfaceOutputAt: {} });
    expect(selectFleetBoard(useStore.getState(), { now: clock, sortMode: 'attention' }).panes
      .find((p) => p.ptyId === 'pty-3')?.unverifiable).toBe(true);
    expect(selectFleetSectionCounts(useStore.getState()).running).toBe(0);
    // No output either: a wedged agent does not keep the computer awake.
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);

    // A quiet tool call: the spinner still repaints.
    useStore.setState({ surfaceOutputAt: { 'pty-3': clock - 30_000 } });
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(true);
    useStore.setState({ agentClockMs: clock - 30_000 + QUIET_TURN_OUTPUT_MS + 1 });
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);
  });

  it('keeps a live agent working while it prints, after its quiet turn was settled to idle', () => {
    const now = Date.now();
    // Main settles a turn whose hooks were silent for 30 min: no latch, no running status.
    seedNothingRunning(now, { agentAliveByPtyId: { 'pty-3': true }, surfaceOutputAt: { 'pty-3': now - 30_000 } });
    expect(selectFleetSectionCounts(useStore.getState()).running).toBe(0);
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(true);

    useStore.setState({ agentClockMs: now + QUIET_TURN_OUTPUT_MS });
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);

    // Only a live agent counts: a plain shell printing does not.
    useStore.setState({ agentClockMs: now, agentAliveByPtyId: {} });
    expect(selectLocalAgentsWorking(useStore.getState())).toBe(false);
  });
});
