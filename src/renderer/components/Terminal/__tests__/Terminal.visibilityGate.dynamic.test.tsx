// @vitest-environment jsdom
//
// #2398 — a blank terminal surface starts its shell only once it is shown. On
// a cold start with many restored workspaces every blank pane used to create
// its pty at mount, visible or not.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import type { DeadPaneRecovery } from '../../../../shared/ptyRecovery';

vi.mock('../../../hooks/useTerminal', () => ({
  useTerminal: () => ({
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
  }),
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
/** The workspace holding the surface under test, and one the user is looking at. */
let ws: Workspace;
let other: Workspace;
let paneId: string;
let surfaceId: string;

const NOT_STARTED = 'Starts when opened';

function leafOf(w: Workspace) {
  if (w.rootPane.type !== 'leaf') throw new Error('fixture expects a leaf root');
  return w.rootPane;
}

/** `ws` holds one blank terminal surface; `other` is active, so `ws` is hidden. */
function seed(extraSurfaces: Array<Record<string, unknown>> = [], activeSurface?: string): void {
  ws = createWorkspace('hidden');
  other = createWorkspace('shown');
  const leaf = leafOf(ws);
  paneId = leaf.id;
  surfaceId = `surf-${Math.random().toString(36).slice(2)}`;
  leaf.surfaces = [
    { id: surfaceId, ptyId: '', title: 'Terminal', shell: 'pwsh.exe', cwd: 'D:\\proj' },
    ...(extraSurfaces as unknown as typeof leaf.surfaces),
  ];
  leaf.activeSurfaceId = activeSurface ?? surfaceId;
  act(() => useStore.setState({
    workspaces: [other, ws],
    activeWorkspaceId: other.id,
    multiviewIds: [],
    appRoute: 'workspaces',
    botsWorkerPanel: null,
    defaultShell: '',
    startupDirectory: '',
    claudeResumeOnStart: false,
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
        isWorkspaceVisible={useStore.getState().activeWorkspaceId === ws.id}
        onPtyCreated={(id) => {
          useStore.getState().updateSurfacePtyId(paneId, surfaceId, id);
          useStore.getState().completeDeadPaneRecovery(surfaceId, id);
        }}
        {...props}
      />,
    );
  });
}

const show = () => act(() => useStore.setState({ activeWorkspaceId: ws.id }));
const hide = () => act(() => useStore.setState({ activeWorkspaceId: other.id }));
function workspaceById(list: Workspace[], id: string): Workspace {
  const found = list.find((w) => w.id === id);
  if (!found) throw new Error(`no workspace ${id}`);
  return found;
}
const storedSurface = () => leafOf(workspaceById(useStore.getState().workspaces, ws.id)).surfaces.find((s) => s.id === surfaceId);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  create = vi.fn().mockImplementation(() => new Promise<Created>((r) => { resolveCreate = r; }));
  dispose = vi.fn();
  cancelCreate = vi.fn().mockResolvedValue(false);
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { create, dispose, cancelCreate } };
  seed();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('a hidden blank surface waits until it is shown (#2398)', () => {
  it('creates nothing while hidden, says it starts when opened, and creates exactly once when first shown', async () => {
    mount();
    expect(create).not.toHaveBeenCalled();
    expect(host.textContent).toContain(NOT_STARTED);
    expect(useStore.getState().ptyCreateByKey[surfaceId]).toBeUndefined();

    show();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ workspaceId: ws.id, surfaceId, cwd: 'D:\\proj' });
    expect(host.textContent).not.toContain(NOT_STARTED);
    // Going away and coming back mid-create neither cancels nor starts another.
    hide();
    show();
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancelCreate).not.toHaveBeenCalled();
    await act(async () => { resolveCreate({ id: 'pty-shown', cwd: 'D:\\proj' }); });
    expect(storedSurface()?.ptyId).toBe('pty-shown');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('hiding the surface while its create is in flight never cancels it', async () => {
    show();
    mount();
    expect(create).toHaveBeenCalledTimes(1);
    hide();
    mount();
    expect(cancelCreate).not.toHaveBeenCalled();
    await act(async () => { resolveCreate({ id: 'pty-kept' }); });
    expect(storedSurface()?.ptyId).toBe('pty-kept');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('a multiview tile counts as shown', () => {
    act(() => useStore.setState({ multiviewIds: [other.id, ws.id] }));
    mount();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a stale multiview entry alone does not (the grid draws only while the active workspace is a tile)', () => {
    act(() => useStore.setState({ multiviewIds: [ws.id, 'ws-gone'] }));
    mount();
    expect(create).not.toHaveBeenCalled();
  });

  it("the split's terminal column counts as shown while the work area is expanded", () => {
    seed([{ id: 'surf-browser', ptyId: '', title: 'Browser', shell: '', surfaceType: 'browser', browserUrl: 'about:blank' }], 'surf-browser');
    show();
    mount({ isActive: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a background tab of a stacked pane waits until it is selected', () => {
    seed([{ id: 'surf-other-tab', ptyId: 'pty-live', title: 'Terminal', shell: 'pwsh.exe' }], 'surf-other-tab');
    show();
    mount({ isActive: false });
    expect(create).not.toHaveBeenCalled();
    act(() => useStore.getState().setActiveSurface(paneId, surfaceId));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a Terminal outside a workspace surface creates at once', () => {
    mount({ surfaceId: undefined, workspaceId: undefined, onPtyCreated: undefined });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('a hidden dead-pane recovery waits with its descriptor (#2398)', () => {
  const recovery: DeadPaneRecovery = {
    sourceSessionId: 'daemon-dead',
    spawnCwd: '/home/me/a',
    cwd: '/home/me/b',
    wslTarget: { distribution: 'Ubuntu', user: 'me' },
  };

  function stage(r: DeadPaneRecovery): void {
    act(() => useStore.getState().stageDeadPaneRecovery(surfaceId, r));
  }

  it('keeps the descriptor through a restart while deferred and uses it on first show', async () => {
    stage(recovery);
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).not.toHaveBeenCalled();
    expect(storedSurface()?.pendingRecovery).toEqual(recovery);

    // A restart while still deferred: the saved workspaces come back as they were.
    act(() => root.unmount());
    root = createRoot(host);
    const saved = JSON.parse(JSON.stringify(useStore.getState().workspaces)) as Workspace[];
    act(() => useStore.setState({ workspaces: saved }));
    ws = workspaceById(saved, ws.id);
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).not.toHaveBeenCalled();

    show();
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0] as Record<string, unknown>;
    expect(options.cwd).toBeUndefined();
    expect(options.recoveryCwds).toEqual({
      spawnCwd: '/home/me/a',
      cwd: '/home/me/b',
      wslTarget: { distribution: 'Ubuntu', user: 'me' },
      args: undefined,
      sourceSessionId: 'daemon-dead',
    });
    await act(async () => { resolveCreate({ id: 'pty-recovered' }); });
    // Bound: the descriptor is consumed only now.
    expect(storedSurface()?.ptyId).toBe('pty-recovered');
    expect(storedSurface()?.pendingRecovery).toBeUndefined();
  });

  const exactBinding = { agent: 'claude', sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/b', ts: 1 };

  it('with resume-on-start on, a hidden pane resuming Claude Code starts at once (§6-2)', () => {
    act(() => useStore.setState({ claudeResumeOnStart: true }));
    stage({ ...recovery, resumeAgent: 'claude', resumeBinding: exactBinding });
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as { recoveryCwds?: unknown }).recoveryCwds).toMatchObject({ sourceSessionId: 'daemon-dead' });
  });

  it('with resume-on-start off, the same pane waits', () => {
    stage({ ...recovery, resumeAgent: 'claude', resumeBinding: exactBinding });
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).not.toHaveBeenCalled();
  });

  it('a Claude Code recovery without an exact session id waits even with resume-on-start on', () => {
    act(() => useStore.setState({ claudeResumeOnStart: true }));
    stage({ ...recovery, resumeAgent: 'claude' });
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).not.toHaveBeenCalled();
  });

  it('a recovery without a resumable agent waits even with resume-on-start on', () => {
    act(() => useStore.setState({ claudeResumeOnStart: true }));
    stage(recovery);
    mount({ pendingRecovery: storedSurface()?.pendingRecovery });
    expect(create).not.toHaveBeenCalled();
  });
});
