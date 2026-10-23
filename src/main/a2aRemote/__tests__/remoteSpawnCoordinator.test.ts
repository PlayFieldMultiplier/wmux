// The app's part of a remote spawn on the receiving PC: cards for requests
// and for held follow-ups, their answers back to the daemon, and the start of
// an approved request (worktree, workspace with the launcher alone, depth
// stamp, started), with what goes wrong on each step answered as a code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_INBOUND_EVENT, A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { A2A_SPAWN_EVENT, A2A_SPAWN_RPC, type A2aSpawnCardV1, type A2aSpawnClaimV1, type A2aSpawnWork } from '../../../shared/a2aSpawn';
import type { ApprovalResult } from '../../mcp/ApprovalQueue';
import { FanOutGuards } from '../../worktask/fanoutGuards';
import { RemoteSpawnCoordinator, type RemoteSpawnCoordinatorDeps } from '../remoteSpawnCoordinator';

const HOST = '11111111-1111-4111-8111-111111111111';
const SPAWN = 'sp-9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const PROMPT = 'delete nothing, but fix the build';

const card: A2aSpawnCardV1 = {
  hostId: HOST, hostName: 'HOME-A', spawnId: SPAWN, agent: 'claude', rootId: 'web', rootLabel: 'Web',
  folder: '/repo/apps', permissionMode: 'auto', followUps: 'ask', text: PROMPT, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};
const claim: A2aSpawnClaimV1 = { hostId: HOST, hostName: 'HOME-A', spawnId: SPAWN, agent: 'claude', repoPath: '/repo', sub: 'apps', permissionMode: 'acceptEdits' };

interface Rig {
  coord: RemoteSpawnCoordinator;
  rpc: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  prompts: Array<{ input: Parameters<RemoteSpawnCoordinatorDeps['consent']['requestConsent']>[0]; resolve: (r: Partial<ApprovalResult>) => void }>;
  cancelled: string[];
  retried: string[];
  stamped: Array<[string, string]>;
  worktree: ReturnType<typeof vi.fn>;
  emit: (type: string) => void;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.coord.stop();
});

function rig(work: () => A2aSpawnWork, over: {
  claim?: () => unknown;
  render?: () => unknown;
  worktree?: () => unknown;
  markDepth?: () => void;
  retryMs?: number;
} = {}): Rig {
  let listener: ((e: { type?: unknown }) => void) | undefined;
  const prompts: Rig['prompts'] = [];
  const cancelled: string[] = [];
  const retried: string[] = [];
  const stamped: Array<[string, string]> = [];
  const rpc = vi.fn(async (method: string) => {
    if (method === A2A_SPAWN_RPC.work) return work();
    if (method === A2A_SPAWN_RPC.claim) return over.claim ? over.claim() : { ok: true, claim };
    return { ok: true };
  });
  const render = vi.fn(async () => (over.render ? over.render() : { workspaceId: 'ws-new', ptyId: 'pty-1', paneId: 'pane-new' }));
  const worktree = vi.fn(async () => (over.worktree ? over.worktree() : { ok: true, worktreePath: '/wt/remote-x', cwd: '/wt/remote-x/apps', branch: `wmux/remote/${SPAWN}` }));
  let n = 0;
  const coord = new RemoteSpawnCoordinator({
    daemonRpc: rpc,
    sendToRenderer: render,
    onDaemonEvent: (l) => {
      listener = l;
      return () => { listener = undefined; };
    },
    consent: {
      requestConsent: (input) => {
        const promptId = `p${++n}`;
        let resolve!: (r: Partial<ApprovalResult>) => void;
        const resolution = new Promise<ApprovalResult>((res) => {
          resolve = (r) => res({ approved: false, promptId, identity: undefined, ...r });
        });
        prompts.push({ input, resolve });
        return { promptId, resolution };
      },
      cancelPrompt: (id) => void cancelled.push(id),
    },
    retryHeld: async (taskId) => void retried.push(taskId),
    markDepth: over.markDepth ?? ((ws, owner) => void stamped.push([ws, owner])),
    createWorktree: worktree as RemoteSpawnCoordinatorDeps['createWorktree'],
    backstopMs: 60_000,
    retryMs: over.retryMs ?? 60_000,
    log: () => undefined,
  });
  const r: Rig = { coord, rpc, render, prompts, cancelled, retried, stamped, worktree, emit: (type) => listener?.({ type }) };
  rigs.push(r);
  return r;
}

const empty = (): A2aSpawnWork => ({ awaiting: [], approved: [], followUps: [] });
const calls = (r: Rig, method: string): unknown[] => r.rpc.mock.calls.filter((c) => c[0] === method).map((c) => c[1]);

describe('cards', () => {
  it('shows a request\'s card in full and sends back once, always or deny', async () => {
    for (const [answer, verdict] of [[{ approved: true }, 'once'], [{ approved: true, remember: true as const }, 'always'], [{ approved: false }, 'deny']] as const) {
      const r = rig(() => ({ ...empty(), awaiting: [card] }));
      r.coord.start();
      await r.coord.whenIdle();
      expect(r.prompts).toHaveLength(1);
      expect(r.prompts[0].input).toMatchObject({
        kind: 'remote-spawn',
        remoteSpawn: { hostId: HOST, hostName: 'HOME-A', agent: 'claude', folder: '/repo/apps', permissionMode: 'auto', followUps: 'ask', text: PROMPT },
      });
      expect(r.prompts[0].input.remoteSpawn).not.toHaveProperty('followUp');
      r.prompts[0].resolve(answer);
      await vi.waitFor(() => expect(calls(r, A2A_SPAWN_RPC.decide)).toEqual([{ hostId: HOST, spawnId: SPAWN, verdict }]), { timeout: 5_000 });
      r.coord.stop();
    }
  });

  it('a card shown once is not shown again on the next event, and goes when the request no longer waits', async () => {
    let awaiting = [card];
    const r = rig(() => ({ ...empty(), awaiting }));
    r.coord.start();
    await r.coord.whenIdle();
    r.emit(A2A_SPAWN_EVENT);
    await r.coord.whenIdle();
    expect(r.prompts).toHaveLength(1);
    awaiting = [];
    r.emit(A2A_SPAWN_EVENT);
    await r.coord.whenIdle();
    expect(r.cancelled).toEqual(['p1']);
  });

  it('a held follow-up gets its own card: allowed, the hold is retried; denied, it is rejected', async () => {
    const follow = { taskId: 'rt-1', hostId: HOST, hostName: 'HOME-A', agent: 'claude' as const, folder: '/repo/apps', permissionMode: 'auto' as const, text: 'and the docs' };
    const r = rig(() => ({ ...empty(), followUps: [follow, { ...follow, taskId: 'rt-2' }] }));
    r.coord.start();
    await r.coord.whenIdle();
    expect(r.prompts.map((p) => p.input.remoteSpawn)).toEqual([
      expect.objectContaining({ followUp: true, text: 'and the docs' }),
      expect.objectContaining({ followUp: true }),
    ]);
    r.prompts[0].resolve({ approved: true });
    r.prompts[1].resolve({ approved: false });
    await vi.waitFor(() => expect(r.retried).toEqual(['rt-1']), { timeout: 5_000 });
    await vi.waitFor(() => expect(calls(r, A2A_REMOTE_RPC.rejectHeld)).toEqual([{ taskId: 'rt-2', reason: 'declined on this PC' }]), { timeout: 5_000 });
  });

  it('an inbound nudge reads the requests again', async () => {
    const r = rig(empty);
    r.coord.start();
    await r.coord.whenIdle();
    r.emit(A2A_REMOTE_INBOUND_EVENT);
    await r.coord.whenIdle();
    expect(calls(r, A2A_SPAWN_RPC.work)).toHaveLength(2);
  });
});

describe('starting an approved request', () => {
  it('worktree, a workspace running the launcher alone, the depth stamp, then started; no wire field reaches the command line or env', async () => {
    const r = rig(() => ({ ...empty(), approved: [{ hostId: HOST, spawnId: SPAWN }] }));
    r.coord.start();
    await vi.waitFor(() => expect(calls(r, A2A_SPAWN_RPC.started)).toHaveLength(1), { timeout: 5_000 });
    expect(r.worktree).toHaveBeenCalledWith({ repoPath: '/repo', sub: 'apps', spawnId: SPAWN });
    expect(r.render).toHaveBeenCalledTimes(1);
    const [method, params] = r.render.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(method).toBe('fanout.spawnWorkspace');
    expect(params).toEqual({
      name: 'From HOME-A',
      cwd: '/wt/remote-x/apps',
      initialCommand: 'claude',
      workerPermissionMode: 'acceptEdits',
      remoteSpawnedBy: { hostId: HOST, name: 'HOME-A', spawnId: SPAWN, agent: 'claude' },
    });
    expect(JSON.stringify(params)).not.toContain(PROMPT);
    expect(r.stamped).toEqual([['ws-new', `remote-spawn:${HOST}`]]);
    expect(calls(r, A2A_SPAWN_RPC.started)).toEqual([{ hostId: HOST, spawnId: SPAWN, workspaceId: 'ws-new', paneId: 'pane-new' }]);
  });

  it('a refused worktree, a workspace that did not open, or a missing stamp each end the request with a code', async () => {
    const cases: Array<[Parameters<typeof rig>[1], string]> = [
      [{ worktree: () => ({ ok: false, code: 'folder-not-allowed', detail: 'filter driver' }) }, 'folder-not-allowed'],
      [{ render: () => ({ error: 'workspace creation failed' }) }, 'failed'],
      [{ markDepth: () => { throw new Error('lineage store unreadable'); } }, 'failed'],
    ];
    for (const [over, code] of cases) {
      const r = rig(() => ({ ...empty(), approved: [{ hostId: HOST, spawnId: SPAWN }] }), over);
      r.coord.start();
      await vi.waitFor(() => expect(calls(r, A2A_SPAWN_RPC.failed)).toEqual([{ hostId: HOST, spawnId: SPAWN, code }]), { timeout: 5_000 });
      expect(calls(r, A2A_SPAWN_RPC.started)).toEqual([]);
      r.coord.stop();
    }
  });

  it('a claim refused with a code is left alone; one that could not be checked now is tried again', async () => {
    const refused = rig(() => ({ ...empty(), approved: [{ hostId: HOST, spawnId: SPAWN }] }), { claim: () => ({ ok: false, error: 'folder-not-allowed', code: 'folder-not-allowed' }) });
    refused.coord.start();
    await refused.coord.whenIdle();
    expect(refused.worktree).not.toHaveBeenCalled();

    let tries = 0;
    const busy = rig(() => ({ ...empty(), approved: tries < 2 ? [{ hostId: HOST, spawnId: SPAWN }] : [] }), {
      claim: () => (++tries === 1 ? { ok: false, error: 'not checked now' } : { ok: true, claim }),
      retryMs: 20,
    });
    busy.coord.start();
    await vi.waitFor(() => expect(calls(busy, A2A_SPAWN_RPC.started)).toHaveLength(1), { timeout: 5_000 });
    expect(tries).toBe(2);
  });
});

describe('depth 1', () => {
  it('a remote-started workspace cannot fan out again; one a same-user agent made unstamped can (loop damping, not a boundary)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-spawn-depth-'));
    try {
      const guards = new FanOutGuards({ dir, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
      guards.markTask('ws-new', `remote-spawn:${HOST}`);
      expect(guards.fanoutOwnerOf('ws-new')).toBe(`remote-spawn:${HOST}`);
      // The documented limit: wmux's own RPCs can make a workspace that carries
      // no stamp, and a same-user agent there passes the depth check. What
      // stops a chain of PCs is each PC's own opt-in and card.
      expect(guards.fanoutOwnerOf('ws-made-by-the-agent')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
