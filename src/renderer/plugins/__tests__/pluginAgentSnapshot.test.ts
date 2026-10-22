// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useStore } from '../../stores';
import { seedFleetTriageStore } from '../../utils/__tests__/fleetTriageFixture';
import { pluginAgentSnapshot, pluginAllAgentSnapshot } from '../pluginAgentSnapshot';
import { PLUGIN_AGENT_MAX_WORKSPACES } from '../../../shared/pluginAgentState';
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

describe('plugin snapshot for every workspace', () => {
  it('lists every local workspace in sidebar order, each exactly as its own snapshot plus its name', () => {
    seedFleetTriageStore(Date.now());
    const store = useStore.getState();
    const data = pluginAllAgentSnapshot(store);
    expect(data.truncated).toBe(false);
    expect(data.workspaces.map((w) => [w.workspaceId, w.name])).toEqual(
      store.workspaces.map((w) => [w.id, w.name]));
    for (const ws of data.workspaces) {
      const { name, ...rest } = ws;
      expect(name).toBe(store.workspaces.find((w) => w.id === ws.workspaceId)?.name);
      expect(rest).toEqual(pluginAgentSnapshot(store, ws.workspaceId, false));
    }
    // More than one workspace has agents: the point of the projection.
    expect(data.workspaces.filter((w) => w.panes.length > 0).map((w) => w.workspaceId)).toEqual(expect.arrayContaining(['ws-1', 'ws-3']));
  });
  it('never carries activity', () => {
    seedFleetTriageStore(Date.now(), { surfaceActivity: { 'pty-3': '$ SECRET_TOKEN=hidden command' } });
    expect(JSON.stringify(pluginAllAgentSnapshot(useStore.getState()))).not.toContain('SECRET_TOKEN');
  });
  it('leaves bot workers and remote PC mirrors out', () => {
    seedFleetTriageStore(Date.now(), { fanoutOrigin: { 'ws-1': { kind: 'bot', botId: 'b1' } } });
    const state = useStore.getState();
    const shadow = { ...state.workspaces[2], id: 'shadow:host-1:rw-1', name: 'mirror' };
    useStore.setState({ workspaces: [...state.workspaces, shadow] });
    const ids = pluginAllAgentSnapshot(useStore.getState()).workspaces.map((w) => w.workspaceId);
    expect(ids).not.toContain('ws-1');
    expect(ids).not.toContain('shadow:host-1:rw-1');
  });
  it('reads the live workspace list: a workspace created or closed is in or out of the next read', () => {
    seedFleetTriageStore(Date.now());
    const before = useStore.getState().workspaces;
    const added = { ...before[2], id: 'ws-new', name: 'new one', rootPane: { ...before[2].rootPane, id: 'p-new' } };
    useStore.setState({ workspaces: [...before.filter((w) => w.id !== 'ws-3'), added] });
    const ids = pluginAllAgentSnapshot(useStore.getState()).workspaces.map((w) => w.workspaceId);
    expect(ids).toContain('ws-new');
    expect(ids).not.toContain('ws-3');
  });
  it('stops at the workspace limit and says so', () => {
    seedFleetTriageStore(Date.now());
    const base = useStore.getState().workspaces[0];
    useStore.setState({ workspaces: Array.from({ length: PLUGIN_AGENT_MAX_WORKSPACES + 2 }, (_, i) => ({ ...base, id: `ws-x${i}`, name: `x${i}` })) });
    const data = pluginAllAgentSnapshot(useStore.getState());
    expect(data.workspaces).toHaveLength(PLUGIN_AGENT_MAX_WORKSPACES);
    expect(data.truncated).toBe(true);
  });
});
