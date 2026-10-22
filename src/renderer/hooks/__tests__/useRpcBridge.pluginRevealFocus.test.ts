// @vitest-environment jsdom
//
// pane.focus with the main-stamped `revealWorkspace` (a UI plugin approved for
// agent.state.read.all) may take the user to a pane in another local workspace.
// It covers exactly the workspaces that grant's snapshot covers: never a bot's
// worker (it lives on the Bots page) and never a remote PC's shadow workspace.
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

function leaf(id: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId: `pty-${id}`, title: id, shell: '', cwd: 'D:\\proj', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}
const workspace = (id: string, paneId: string) => ({ id, name: id, rootPane: leaf(paneId), activePaneId: paneId }) as Workspace;

const HOME = workspace('ws-home', 'pane-home');
const LOCAL = workspace('ws-local', 'pane-local');
const BOT = workspace('ws-bot-worker', 'pane-bot');
const SHADOW = workspace('shadow:host-1:remote-1', 'pane-shadow');

beforeEach(() => {
  useStore.setState({
    workspaces: JSON.parse(JSON.stringify([HOME, LOCAL, BOT, SHADOW])) as Workspace[],
    activeWorkspaceId: HOME.id,
    paneGate: 'ready',
    fanoutOrigin: { [BOT.id]: { kind: 'bot', botId: 'bot-1' } },
  });
});

describe('pane.focus revealing another workspace', () => {
  it('takes the user to a pane in another local workspace', async () => {
    expect(await handleRpcMethod('pane.focus', { id: 'pane-local', revealWorkspace: true })).toEqual({ ok: true });
    expect(useStore.getState().activeWorkspaceId).toBe(LOCAL.id);
    expect(useStore.getState().workspaces.find((w) => w.id === LOCAL.id)?.activePaneId).toBe('pane-local');
  });

  // A bot worker is a local workspace the store holds: the reveal branch
  // itself turns it away. A shadow workspace never reaches it at all: every
  // RPC reads the store without the PC rail's shadows, so its pane is unknown.
  it.each([
    ['a bot worker', 'pane-bot', 'pane.focus: pane pane-bot is outside the calling workspace'],
    ['a remote PC (shadow) workspace', 'pane-shadow', 'pane.focus: pane pane-shadow not found'],
  ])('refuses a pane in %s and leaves the screen where it was', async (_kind, paneId, error) => {
    const before = useStore.getState().workspaces;
    expect(await handleRpcMethod('pane.focus', { id: paneId, revealWorkspace: true })).toEqual({ error });
    expect(useStore.getState().activeWorkspaceId).toBe(HOME.id);
    expect(useStore.getState().workspaces).toBe(before);
  });
});
