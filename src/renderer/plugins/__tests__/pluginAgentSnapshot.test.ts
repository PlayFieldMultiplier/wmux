// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useStore } from '../../stores';
import { seedFleetTriageStore } from '../../utils/__tests__/fleetTriageFixture';
import { pluginAgentSnapshot } from '../pluginAgentSnapshot';
import { selectFleetBoard, fleetRow } from '../../stores/selectors/fleet';
import { ownerFleetState } from '../../components/Sidebar/botTasks';

describe('plugin snapshot projection', () => {
  it('matches final Fleet sections and excludes shell, remote and other workspaces', () => {
    seedFleetTriageStore(Date.now());
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const data = pluginAgentSnapshot(store, ws.id, false);
      const board = selectFleetBoard(ownerFleetState(store), { now: store.agentClockMs, sortMode: 'attention' });
      for (const agent of data.panes) {
        const pane = board.panes.find((p) => p.paneId === agent.paneId)!;
        expect(pane.workspaceId).toBe(ws.id);
        const section = fleetRow(pane, { surfacePendingQuestion: store.surfacePendingQuestion }).section;
        expect(agent.state).toBe(section === 'running' ? 'working' : section === 'idle' ? 'resting' : section);
      }
    }
    expect(pluginAgentSnapshot(store, 'ws-r', false).panes).toEqual([]);
    expect(pluginAgentSnapshot(store, 'ws-4', false).panes).toEqual([]);
    expect(pluginAgentSnapshot(store, 'ws-1', false).panes[0].state).toBe('needsYou');
    expect(pluginAgentSnapshot(store, 'ws-3', false).panes[0].state).toBe('working');
  });
  it('excludes activity, terminal title and prompt bodies from the base read', () => {
    seedFleetTriageStore(Date.now(), { surfaceActivity: { 'pty-3': '$ SECRET_TOKEN=hidden command' } });
    const state = useStore.getState();
    const data = JSON.stringify(pluginAgentSnapshot(state, 'ws-1', false));
    expect(data).not.toContain('migrate billing');
    expect(data).not.toContain('Run the migration');
    expect(JSON.stringify(pluginAgentSnapshot(state, 'ws-3', false))).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(pluginAgentSnapshot(state, 'ws-3', true))).toContain('SECRET_TOKEN');
  });
  it('excludes a mixed local/remote pane even when the local tab is active', () => {
    seedFleetTriageStore(Date.now());
    const state = useStore.getState();
    const ws = state.workspaces[0];
    if (ws.rootPane.type !== 'leaf') throw new Error('Expected leaf');
    const rootPane = { ...ws.rootPane, surfaces: [...ws.rootPane.surfaces, { id: 'remote-tab', ptyId: '', title: 'remote secret', shell: '', cwd: '', surfaceType: 'remote-terminal' as const, remoteHostId: 'host-1', remoteSessionId: 'rsession-9' }] };
    useStore.setState({ workspaces: [{ ...ws, rootPane }, ...state.workspaces.slice(1)] });
    expect(pluginAgentSnapshot(useStore.getState(), ws.id, false).panes).toEqual([]);
  });
  it('leaves bot-owned workspaces out', () => {
    seedFleetTriageStore(Date.now(), { fanoutOrigin: { 'ws-1': { kind: 'bot', botId: 'b1' } } });
    expect(pluginAgentSnapshot(useStore.getState(), 'ws-1', false).panes).toEqual([]);
  });
});
