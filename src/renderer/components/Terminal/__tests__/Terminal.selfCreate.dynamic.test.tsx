// @vitest-environment jsdom
//
// #2398 — a blank terminal surface creates its own PTY. These pin what that
// create asks for and the order the result is bound in, for a pane that is on
// screen, so moving the create into the per-surface lifecycle cannot change
// what a visible pane gets.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { createWorkspace, type Workspace } from '../../../../shared/types';

/** Every ptyId useTerminal was rendered with, in order. */
const seenPtyIds: (string | undefined)[] = [];

vi.mock('../../../hooks/useTerminal', () => ({
  useTerminal: (_ref: unknown, options: { ptyId?: string | null }) => {
    seenPtyIds.push(options.ptyId ?? undefined);
    return {
      terminal: { current: null },
      terminalInstance: null,
      fit: vi.fn(),
      searchAddonRef: { current: null },
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearSearch: vi.fn(),
      getScrollPosition: () => 0,
      scrollToLine: vi.fn(),
      retryConnection: vi.fn(),
    };
  },
  copySelectionWithFeedback: vi.fn(),
  getPaneSyncUi: () => null,
  subscribePaneSyncUi: () => (): void => undefined,
}));
vi.mock('../SearchBar', () => ({ default: () => null }));
vi.mock('../ViCopyMode', () => ({ default: () => null }));
vi.mock('../BookmarkIndicator', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ default: () => null }));

import TerminalComponent from '../Terminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Created = { id: string; cwd?: string };
let host: HTMLDivElement;
let root: Root;
let create: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let cancelCreate: ReturnType<typeof vi.fn>;
let resolveCreate: (value: Created) => void;
let ws: Workspace;
let paneId: string;
let surfaceId: string;
const order: string[] = [];
const heal = useStore.getState().updateSurfaceCwd;

function seed(): void {
  ws = createWorkspace('ws');
  if (ws.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  paneId = ws.rootPane.id;
  surfaceId = `surf-${Math.random().toString(36).slice(2)}`;
  ws.rootPane.surfaces = [{ id: surfaceId, ptyId: '', title: 'Terminal', shell: 'pwsh.exe', cwd: 'D:\\proj' }];
  ws.rootPane.activeSurfaceId = surfaceId;
  act(() => useStore.setState({
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    defaultShell: '',
    startupDirectory: '',
  }));
}

function mount(props: Partial<React.ComponentProps<typeof TerminalComponent>> = {}): void {
  act(() => {
    root.render(
      <TerminalComponent
        shell="pwsh.exe"
        cwd={'D:\\proj'}
        workspaceId={ws.id}
        surfaceId={surfaceId}
        onPtyCreated={(id) => {
          order.push(`bind:${id}`);
          useStore.getState().updateSurfacePtyId(paneId, surfaceId, id);
        }}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  seenPtyIds.length = 0;
  order.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  create = vi.fn().mockImplementation(() => new Promise<Created>((r) => { resolveCreate = r; }));
  dispose = vi.fn();
  cancelCreate = vi.fn().mockResolvedValue(false);
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose, cancelCreate } };
  seed();
  act(() => useStore.setState({
    updateSurfaceCwd: (ptyId: string, cwd: string) => { order.push(`heal:${ptyId}:${cwd}`); heal(ptyId, cwd); },
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('Terminal self-create for a visible blank surface', () => {
  it('asks once, with the surface identity and its cwd', () => {
    mount();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({
      shell: 'pwsh.exe',
      cwd: 'D:\\proj',
      cols: undefined,
      rows: undefined,
      workspaceId: ws.id,
      surfaceId,
      spawnKind: 'user-shell',
    });
  });

  it('binds the store first, heals the cwd, then renders the terminal with the new id', async () => {
    mount();
    await act(async () => { resolveCreate({ id: 'pty-new', cwd: 'D:\\proj' }); });
    expect(order).toEqual(['bind:pty-new', 'heal:pty-new:D:\\proj']);
    expect(seenPtyIds.at(-1)).toBe('pty-new');
    expect(dispose).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not heal the cwd when main spawned somewhere else', async () => {
    mount();
    await act(async () => { resolveCreate({ id: 'pty-home', cwd: 'C:\\Users\\me' }); });
    expect(order).toEqual(['bind:pty-home']);
  });

  it('a surface replacing a dead session asks for that session’s directories and target', () => {
    mount({ pendingRecovery: { sourceSessionId: 'daemon-1', spawnCwd: '/home/me/a', cwd: '/home/me/b', wslTarget: { distribution: 'Ubuntu', user: 'me' } } });
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0] as Record<string, unknown>;
    expect(options.cwd).toBeUndefined();
    expect(options.recoveryCwds).toEqual({
      spawnCwd: '/home/me/a',
      cwd: '/home/me/b',
      wslTarget: { distribution: 'Ubuntu', user: 'me' },
      args: undefined,
      sourceSessionId: 'daemon-1',
    });
  });

  it('a surface that already has a pty creates nothing', () => {
    mount({ ptyId: 'pty-live' });
    expect(create).not.toHaveBeenCalled();
    expect(seenPtyIds.at(-1)).toBe('pty-live');
  });
});

describe('Terminal self-create through the per-surface lifecycle (#2398)', () => {
  const closeSurface = () => act(() => {
    const leaf = useStore.getState().workspaces[0].rootPane;
    if (leaf.type !== 'leaf') throw new Error('fixture expects a leaf root');
    useStore.setState({ workspaces: [{ ...useStore.getState().workspaces[0], rootPane: { ...leaf, surfaces: [] } }] });
  });

  it('a remount mid-create joins the create instead of starting a second one', async () => {
    mount();
    act(() => root.render(<></>));
    mount();
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancelCreate).not.toHaveBeenCalled();
    await act(async () => { resolveCreate({ id: 'pty-joined', cwd: 'D:\\proj' }); });
    expect(order).toEqual(['bind:pty-joined', 'heal:pty-joined:D:\\proj']);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('closing the surface mid-create cancels it and disposes the late pty', async () => {
    mount();
    closeSurface();
    act(() => root.render(<></>));
    expect(cancelCreate).toHaveBeenCalledWith(surfaceId);
    await act(async () => { resolveCreate({ id: 'pty-late' }); });
    expect(order).toEqual([]);
    expect(dispose).toHaveBeenCalledWith('pty-late');
  });

  it('a refused create shows its reason and Retry, and never fires again by itself', async () => {
    create.mockImplementationOnce(() => Promise.reject(new Error('[RESOURCE_EXHAUSTED] session cap reached')));
    mount();
    await act(async () => { await Promise.resolve(); });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This terminal could not start.');
    // A remount (or any re-run of the effect) does not fire it again.
    act(() => root.render(<></>));
    mount();
    expect(create).toHaveBeenCalledTimes(1);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    expect(retry).toBeDefined();
    act(() => { retry?.click(); });
    expect(create).toHaveBeenCalledTimes(2);
    await act(async () => { resolveCreate({ id: 'pty-retried' }); });
    expect(order).toEqual(['bind:pty-retried']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('a bound pane whose binding is cleared, and whose replacement is refused, still shows Retry', async () => {
    mount({ ptyId: 'pty-old' });
    expect(seenPtyIds.at(-1)).toBe('pty-old');
    create.mockImplementationOnce(() => Promise.reject(new Error('[RESOURCE_EXHAUSTED] session cap reached')));
    // The reconnect said session-dead: the store binding is cleared.
    mount({ ptyId: undefined });
    await act(async () => { await Promise.resolve(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This terminal could not start.');
  });

  it('a refusal ends once the surface is bound: a later clear creates again', async () => {
    create.mockImplementationOnce(() => Promise.reject(new Error('[RESOURCE_EXHAUSTED] session cap reached')));
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(useStore.getState().ptyCreateByKey[surfaceId]?.state).toBe('createFailed');
    // Another path binds it, then that session dies and the binding is cleared.
    mount({ ptyId: 'pty-other' });
    expect(useStore.getState().ptyCreateByKey[surfaceId]).toBeUndefined();
    mount({ ptyId: undefined });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
