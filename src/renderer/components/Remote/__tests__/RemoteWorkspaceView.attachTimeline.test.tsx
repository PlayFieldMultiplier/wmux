// @vitest-environment jsdom
//
// #2101 — PaneCell logs its attach timeline once when a run stays unattached
// with no error past ATTACH_STUCK_MS. Diagnostics only: these tests also check
// that the cell's attach and detach calls are the same as without the log.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RemoteWorkspaceView from '../RemoteWorkspaceView';
import { ATTACH_STUCK_MS } from '../attachTimeline';
import type { AttachedRemoteWorkspace } from '../../../stores/slices/remoteWorkspacesSlice';

vi.mock('../RemoteMirrorTerminal', () => ({
  default: ({ attachId }: { attachId: string | null }) =>
    React.createElement('div', { 'data-attach-id': attachId ?? '' }),
}));

vi.mock('../../../hooks/useT', () => ({ useT: () => (k: string) => k }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AttachResult = { ok: true; attachId: string };

let container: HTMLDivElement;
let root: Root;
let paneAttach: ReturnType<typeof vi.fn>;
let paneDetach: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
/** Resolvers of attaches that have not answered yet, in call order. */
let pending: Array<(v: AttachResult) => void>;

function installElectronApi(answer: 'never' | 'now'): void {
  pending = [];
  let n = 0;
  paneAttach = vi.fn(() => {
    n += 1;
    const id = `att-${n}`;
    if (answer === 'now') return Promise.resolve({ ok: true, attachId: id });
    return new Promise<AttachResult>((resolve) => { pending.push(resolve); });
  });
  paneDetach = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      paneAttach,
      paneDetach,
      hostsList: vi.fn(async () => [{ id: 'h1', label: 'office-mac', origin: 'https://x', addedAt: 0, allowInput: true }]),
    },
  };
}

function workspace(overrides: Partial<AttachedRemoteWorkspace> = {}): AttachedRemoteWorkspace {
  return {
    key: 'h1:ws-1',
    hostId: 'h1',
    hostLabel: 'office-mac',
    workspaceId: 'ws-1',
    name: 'Remote WS',
    panes: [{ sessionId: 'sess-0001-aaaa' }],
    ...overrides,
  };
}

function render(w: AttachedRemoteWorkspace): void {
  act(() => { root.render(React.createElement(RemoteWorkspaceView, { workspace: w })); });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await settle();
}

function attachLogs(): string[] {
  return warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.startsWith('[wmux:remote-attach]'));
}

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PaneCell attach timeline (#2101)', () => {
  it('logs nothing when the attach answers', async () => {
    installElectronApi('now');
    render(workspace());
    await settle();
    await advance(ATTACH_STUCK_MS + 1_000);

    expect(container.querySelector('[data-attach-id="att-1"]')).not.toBeNull();
    expect(attachLogs()).toEqual([]);
  });

  it('logs the timeline once when the attach was sent and never answered', async () => {
    installElectronApi('never');
    render(workspace({ attachEpoch: 2 }));
    await settle();
    await advance(ATTACH_STUCK_MS - 1);
    expect(attachLogs()).toEqual([]);

    await advance(1);
    const logs = attachLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('host=h1 cell still unattached');
    expect(logs[0]).toMatch(/#1 epoch=2 session=sess-000 \[start@0 attach-sent@\d+\]/);

    await advance(ATTACH_STUCK_MS * 3);
    expect(attachLogs()).toHaveLength(1);
  });

  it('logs how long a late answer took, and the cell still attaches', async () => {
    installElectronApi('never');
    render(workspace());
    await settle();
    await advance(ATTACH_STUCK_MS + 2_000);

    await act(async () => { pending[0]({ ok: true, attachId: 'att-1' }); });
    await settle();

    const logs = attachLogs();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/run #1 answered after 7000ms: #1 .*ok@7000\]/);
    expect(container.querySelector('[data-attach-id="att-1"]')).not.toBeNull();
  });

  it('shows a run still waiting on the previous run\'s teardown', async () => {
    // The first attach never answers; the epoch changes. The new run waits for
    // the old run's teardown, so it never sends its own attach.
    installElectronApi('never');
    render(workspace({ attachEpoch: 1 }));
    await settle();
    render(workspace({ attachEpoch: 2 }));
    await settle();
    expect(paneAttach).toHaveBeenCalledTimes(1);

    await advance(ATTACH_STUCK_MS);
    const logs = attachLogs();
    // Only the live run reports; the cancelled one's timer was cleared.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/#1 epoch=1 \S+ \[start@0 attach-sent@0 cancelled@0\] \| #2 epoch=2 \S+ \[start@0\]$/);
  });

  it('a run cancelled before the deadline never reports', async () => {
    installElectronApi('never');
    render(workspace({ attachEpoch: 1 }));
    await settle();
    act(() => { root.unmount(); });
    root = createRoot(container);
    // The cell's deadline timer goes with it.
    expect(vi.getTimerCount()).toBe(0);
    await advance(ATTACH_STUCK_MS * 2);
    expect(attachLogs()).toEqual([]);
    // Unchanged behaviour: one attach, no detach (it never got an id).
    expect(paneAttach).toHaveBeenCalledTimes(1);
    expect(paneDetach).not.toHaveBeenCalled();
  });
});
