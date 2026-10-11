import { describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace/ptyOwnership', () => ({ resolvePtyOwnerWorkspace: vi.fn(async () => 'ws-seal') }));
vi.mock('../../workspace/WorkspaceMirror', () => ({
  getWorkspaceMirror: () => ({ getEntries: () => [{ id: 'ws-seal', name: 'wseal' }] }),
}));

import { createMoaHandoffService, paneRows, resolveTarget } from '../moaHandoffHost';

// The answer the operator lane really gives for pane.list (pane.rpc.ts).
const envelope = {
  id: 'r1',
  ok: true,
  result: {
    asOfSeq: 13,
    bootId: 'boot',
    panes: [
      { id: 'pane-a', agents: [{ ptyId: 'daemon-1', surfaceId: 'surface-1', agentName: 'Claude Code', agentStatus: 'idle' }] },
    ],
  },
};

describe('moa hand-off host — target resolution', () => {
  it('reads the panes out of the real pane.list envelope', () => {
    expect(paneRows(envelope)).toHaveLength(1);
    expect(paneRows({ ok: true, result: [] })).toEqual([]);
    expect(paneRows(null)).toEqual([]);
  });

  it('resolves a ptyId and a paneId to the pane and its agent', async () => {
    const invoke = vi.fn(async () => envelope);
    const want = { workspaceId: 'ws-seal', paneId: 'pane-a', ptyId: 'daemon-1', surfaceId: 'surface-1', agentName: 'Claude Code', agentStatus: 'idle' };
    expect(await resolveTarget(invoke, () => null, { ptyId: 'daemon-1' })).toEqual(want);
    expect(await resolveTarget(invoke, () => null, { paneId: 'pane-a' })).toEqual(want);
    expect(await resolveTarget(invoke, () => null, { ptyId: 'daemon-9' })).toBeNull();
  });
});


describe('Moa 상태 조회 포트', () => {
  it('단건 경량 조회를 사용하고 없음과 조회 실패를 구분한다', async () => {
    const invoke = vi.fn();
    const service = createMoaHandoffService({ invoke, getWindow: () => null, notify: vi.fn() });
    const { ports } = service as unknown as { ports: { taskState: (id: string) => Promise<string | null | undefined> } };
    invoke.mockResolvedValueOnce({ ok: true, result: { tasks: [{ id: 'task-1', status: { state: 'completed' } }] } });
    expect(await ports.taskState('task-1')).toBe('completed');
    expect(invoke).toHaveBeenLastCalledWith('a2a.task.query', expect.objectContaining({ view: 'state', taskId: 'task-1' }));
    invoke.mockResolvedValueOnce({ ok: true, result: { tasks: [] } });
    expect(await ports.taskState('missing')).toBeNull();
    invoke.mockRejectedValueOnce(new Error('unavailable'));
    expect(await ports.taskState('task-1')).toBeUndefined();
  });
});
