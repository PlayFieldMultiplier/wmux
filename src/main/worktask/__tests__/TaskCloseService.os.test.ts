// ─── TaskCloseService — J3 §1 close 순서 계약(remove 성공 → close 커밋) ──────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { TaskCloseService } from '../TaskCloseService';
import type { CloseDaemonPort } from '../TaskCloseService';
import { TaskWorktreeManager } from '../TaskWorktreeManager';
import { PendingWorktreeRemovals } from '../pendingWorktreeRemovals';

let repoRoot: string;
let wtBase: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd }).toString();
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-repo-'));
  wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-wt-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.t'], repoRoot);
  git(['config', 'user.name', 't'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'a\n');
  git(['add', '.'], repoRoot);
  git(['commit', '-q', '-m', 'init'], repoRoot);
});
afterEach(() => {
  for (const d of [repoRoot, wtBase]) fs.rmSync(d, { recursive: true, force: true });
});

function makeDaemon(closeResult?: unknown): { port: CloseDaemonPort; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: CloseDaemonPort = {
    rpc: vi.fn(async (method, params) => {
      calls.push({ method, params });
      return closeResult ?? { ok: true, taskId: params['taskId'] };
    }),
  };
  return { port, calls };
}

async function makeWorktree(slug: string): Promise<{ mgr: TaskWorktreeManager; worktreePath: string; metaDir: string }> {
  const mgr = new TaskWorktreeManager();
  const worktreePath = path.join(wtBase, slug);
  const metaDir = path.join(wtBase, '.meta', slug);
  const created = await mgr.createWorktree({
    repoRoot,
    repoHash: 'closehash',
    taskSlug: slug,
    worktreePath,
    branch: `wtask/${slug}`,
    metaDir,
  });
  if (!created.ok) throw new Error(`worktree create failed: ${created.error}`);
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'prompt.md'), 'prompt\n');
  return { mgr, worktreePath, metaDir };
}

describe('J3 §1 close 순서 계약', () => {
  it('clean: remove 성공 → close 커밋 → meta 삭제 (순서 역전 계약)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('clean-task');
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });

    const res = await svc.closeTask({
      taskId: 'wtask-1',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(true);
    // worktree 제거 + meta 삭제 + close RPC 1회.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(metaDir)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('task.mission.close');
  });

  it('dirty: remove 거부 + close 보류(RPC 0회) + 보존 경로 반환', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('dirty-task');
    fs.writeFileSync(path.join(worktreePath, 'wip.txt'), 'uncommitted\n');
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });

    const res = await svc.closeTask({
      taskId: 'wtask-2',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('dirty');
    expect(res.preservedWorktree).toBe(worktreePath);
    // close 보류 — 태스크는 open 유지(모순 상태 제거).
    expect(calls).toHaveLength(0);
    // 산출물·prompt.md 보존.
    expect(fs.existsSync(path.join(worktreePath, 'wip.txt'))).toBe(true);
    expect(fs.existsSync(metaDir)).toBe(true);
  });

  it('a failed status check is preserved but reported as an error, not as dirty (#1461)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('broken-task');
    // Stub only the remove step with the result removeWorktree returns when its
    // `git status` fails. Corrupting a real `.git` to get there is not portable
    // (Windows refuses to open the hidden `.git` file for writing).
    const removeWorktree = vi.fn(async () => ({
      ok: false as const,
      error: 'removeWorktree: status check failed: fatal: not a git repository',
      preserved: true,
    }));
    const worktrees = Object.assign(Object.create(mgr) as TaskWorktreeManager, { removeWorktree });
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees });

    const res = await svc.closeTask({
      taskId: 'wtask-2b',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('error');
    expect(res.error).toContain('status check failed');
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    // Still nothing removed and nothing closed.
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('미push 커밋: 진행 중단 + unpushed 경고(remove·close 0회)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('ahead-task');
    // 원격이 있어야 경고 게이트가 켜진다(로컬 전용 repo는 오탐 방지로 생략).
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-remote-'));
    git(['init', '-q', '--bare'], remoteDir);
    git(['remote', 'add', 'origin', remoteDir], repoRoot);
    // worktree에 커밋 1개(미push).
    fs.writeFileSync(path.join(worktreePath, 'done.txt'), 'work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-q', '-m', '산출물'], worktreePath);

    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({
      taskId: 'wtask-3',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('unpushed');
    expect(res.aheadCount).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it('a HEAD that is the commit task_push last published counts as pushed, with no upstream; the relay is removed on close', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('pushed-task');
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-close-remote-'));
    git(['init', '-q', '--bare'], remoteDir);
    git(['remote', 'add', 'origin', remoteDir], repoRoot);
    fs.writeFileSync(path.join(worktreePath, 'done.txt'), 'work\n');
    git(['add', '.'], worktreePath);
    git(['commit', '-q', '-m', 'work'], worktreePath);
    const head = git(['rev-parse', 'HEAD'], worktreePath).trim();
    const { port } = makeDaemon();
    const removed: string[] = [];
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr, pushedHead: (id) => (id === 'wtask-p' ? head : null), removeRelay: (id) => { removed.push(id); } });
    const res = await svc.closeTask({ taskId: 'wtask-p', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath, metaDir });
    expect(res.ok).toBe(true);
    expect(removed).toEqual(['wtask-p']);
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it('the relay removal is queued, not awaited: a removal stuck behind a relay call does not delay the close', async () => {
    const { port } = makeDaemon();
    let timer: NodeJS.Timeout | undefined;
    const removeRelay = vi.fn(() => new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }));
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager(), removeRelay });
    const started = Date.now();
    try {
      const res = await svc.closeTask({ taskId: 'wtask-slow', verifiedWorkspaceId: 'ws-owner' });
      expect(res.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(removeRelay).toHaveBeenCalledWith('wtask-slow');
    } finally {
      clearTimeout(timer);
    }
  });

  it('미물질화(worktreePath 부재): worktree 단계 건너뛰고 close만', async () => {
    const { port, calls } = makeDaemon();
    const mgr = new TaskWorktreeManager();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({ taskId: 'wtask-4', verifiedWorkspaceId: 'ws-owner' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.unmaterialized).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a close that stopped the worktree\'s panes reports them; a close-only task, whose panes nothing stopped, reports none (#2393)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('stopped-task');
    const { port } = makeDaemon();
    const panesStopped = vi.fn();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr, stopPanesIn: async () => ['p-1', 'p-2'], panesStopped });
    const res = await svc.closeTask({ taskId: 'wtask-6', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath, metaDir });
    expect(res.ok).toBe(true);
    expect(panesStopped).toHaveBeenCalledWith('wtask-6', ['p-1', 'p-2']);

    panesStopped.mockClear();
    const res2 = await svc.closeTask({ taskId: 'wtask-7', verifiedWorkspaceId: 'ws-owner' });
    expect(res2.ok).toBe(true);
    expect(panesStopped).not.toHaveBeenCalled();
  });

  it('archivePending: 데몬 응답의 archive 미확정이 결과에 전달된다(CX2)', async () => {
    const { mgr, worktreePath, metaDir } = await makeWorktree('pending-task');
    const { port } = makeDaemon({ ok: true, taskId: 'wtask-5', archivePending: true });
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const res = await svc.closeTask({
      taskId: 'wtask-5',
      verifiedWorkspaceId: 'ws-owner',
      repoRoot,
      repoHash: 'closehash',
      worktreePath,
      metaDir,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.archivePending).toBe(true);
  });
});

// #2388: a folder an earlier close left half removed (git dropped the
// worktree, part of the folder stayed) is finished before a close-only task
// closes; the task stays open while it cannot be.
describe('close-only with a leftover folder (#2388)', () => {
  const fakeWorktrees = (result: Awaited<ReturnType<TaskWorktreeManager['finishPendingRemoval']>>) => {
    const finishPendingRemoval = vi.fn(async (_p: string, stop?: (p: string) => Promise<void>) => {
      await stop?.(_p);
      return result;
    });
    return { worktrees: { finishPendingRemoval } as unknown as TaskWorktreeManager, finishPendingRemoval };
  };

  it('finishes the recorded removal, stopping the panes in the folder first, then closes', async () => {
    const { port, calls } = makeDaemon();
    const { worktrees, finishPendingRemoval } = fakeWorktrees({ ok: true });
    const panesStopped = vi.fn();
    const svc = new TaskCloseService({ daemon: port, worktrees, stopPanesIn: async () => ['p-1'], panesStopped });
    const res = await svc.closeTask({ taskId: 'wtask-8', verifiedWorkspaceId: 'ws-owner', leftoverPath: '/wt/left' });
    expect(res).toMatchObject({ ok: true, unmaterialized: true });
    expect(finishPendingRemoval).toHaveBeenCalledWith('/wt/left', expect.any(Function), { keepWhenRepoGone: true });
    expect(calls.map((c) => c.method)).toEqual(['task.mission.close']);
    expect(panesStopped).toHaveBeenCalledWith('wtask-8', ['p-1']);
  });

  it('keeps the task open, and says where the folder is, when the leftover could not be removed', async () => {
    const { port, calls } = makeDaemon();
    const { worktrees } = fakeWorktrees({ ok: false, error: 'removeWorktree: the leftover folder was kept: 1 file(s) in it are not what git left', preserved: true, dirty: true });
    const svc = new TaskCloseService({ daemon: port, worktrees });
    const res = await svc.closeTask({ taskId: 'wtask-9', verifiedWorkspaceId: 'ws-owner', leftoverPath: '/wt/left' });
    expect(res).toMatchObject({ ok: false, reason: 'dirty', preservedWorktree: '/wt/left' });
    expect(calls).toHaveLength(0);
  });

  it('closes as before when no removal of the folder is recorded', async () => {
    const { port, calls } = makeDaemon();
    const { worktrees } = fakeWorktrees(null);
    const svc = new TaskCloseService({ daemon: port, worktrees });
    expect((await svc.closeTask({ taskId: 'wtask-10', verifiedWorkspaceId: 'ws-owner', leftoverPath: '/wt/left' })).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // Its repository moved or deleted, the folder can never pass git's checks
  // again: without a way out, every close of the task refused, forever.
  it('a half-removed folder whose repository is gone: the close keeps the folder, names it, and closes', async () => {
    const root = path.join(wtBase, 'root');
    const left = path.join(root, 'task-gone');
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, 'held.txt'), 'x\n');
    const store = new PendingWorktreeRemovals(path.join(wtBase, 'wmux', 'worktask', 'pending-removals.json'));
    await store.put({ path: left, repoRoot: path.join(wtBase, 'moved-away'), repoHash: 'closehash', at: 1 });
    const stopPanesIn = vi.fn(async () => []);
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: store }), stopPanesIn });
    const res = await svc.closeTask({ taskId: 'wtask-k4', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: true, unmaterialized: true, keptFolder: left });
    expect(calls.map((c) => c.method)).toEqual(['task.mission.close']);
    // Nothing is deleted: the folder is kept as it is. Its panes end with
    // the task, before the close.
    expect(stopPanesIn).toHaveBeenCalledWith(left);
    expect(fs.readFileSync(path.join(left, 'held.txt'), 'utf8')).toBe('x\n');
    expect(store.all()).toEqual([]);
  });

  // A task never closed whose repository was deleted since: no removal is
  // recorded, the folder stays, and its worker kept running after the close.
  it('a folder with no recorded removal that stays: its panes are stopped first, and the result names it', async () => {
    const left = path.join(wtBase, 'root', 'task-never-closed');
    fs.mkdirSync(left, { recursive: true });
    const order: string[] = [];
    const { port, calls } = makeDaemon();
    const rpc = port.rpc;
    port.rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      order.push(method);
      return rpc(method, params);
    }) as CloseDaemonPort['rpc'];
    // No removal recorded: the folder is not looked at there.
    const worktrees = { finishPendingRemoval: vi.fn(async () => null) } as unknown as TaskWorktreeManager;
    const panesStopped = vi.fn();
    const stopPanesIn = vi.fn(async (dir: string) => {
      order.push(`stop ${dir}`);
      return ['p-claude'];
    });
    const svc = new TaskCloseService({ daemon: port, worktrees, stopPanesIn, panesStopped });
    const res = await svc.closeTask({ taskId: 'wtask-k5', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: true, unmaterialized: true, keptFolder: left });
    expect(order).toEqual([`stop ${left}`, 'task.mission.close']);
    expect(panesStopped).toHaveBeenCalledWith('wtask-k5', ['p-claude']);
    expect(calls).toHaveLength(1);
  });

  it('a folder that stays whose panes could not be stopped keeps the task open', async () => {
    const left = path.join(wtBase, 'root', 'task-held');
    fs.mkdirSync(left, { recursive: true });
    const { port, calls } = makeDaemon();
    const worktrees = { finishPendingRemoval: vi.fn(async () => null) } as unknown as TaskWorktreeManager;
    const svc = new TaskCloseService({ daemon: port, worktrees, stopPanesIn: async () => { throw new Error("this pane's process identity isn't known yet"); } });
    const res = await svc.closeTask({ taskId: 'wtask-k6', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: false, reason: 'error', preservedWorktree: left });
    if (!res.ok) expect(res.error).toMatch(/task stays open and the folder is kept.*identity isn't known yet/);
    expect(calls).toHaveLength(0);
  });
});

// #2388: Close and keep folder, the owner's way out of a close that keeps
// refusing: the task closes and its folder stays as it is.
describe('a close that keeps the folder (#2388)', () => {
  const storeIn = (dir: string): PendingWorktreeRemovals => new PendingWorktreeRemovals(path.join(dir, 'wmux', 'worktask', 'pending-removals.json'));

  it('keepFolder closes the task, leaves the worktree on disk and in git, and ends its records', async () => {
    const { worktreePath } = await makeWorktree('keep-a');
    fs.writeFileSync(path.join(worktreePath, 'wip.txt'), 'uncommitted\n');
    const store = storeIn(wtBase);
    await store.put({ path: worktreePath, repoRoot, repoHash: 'closehash', at: 1 });
    const mgr = new TaskWorktreeManager({ pendingRemovals: store });
    const { port, calls } = makeDaemon();
    const stopPanesIn = vi.fn(async () => ['p-1']);
    const forgetStops = vi.fn();
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr, stopPanesIn, forgetStops });
    const res = await svc.closeTask({ taskId: 'wtask-k1', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath, keepFolder: true });
    expect(res).toEqual({ ok: true, taskId: 'wtask-k1', archivePending: false, keptFolder: worktreePath });
    expect(calls.map((c) => c.method)).toEqual(['task.mission.close']);
    // A detach close: the cleanup scan, the closed-task GC and a bot task's
    // folder cleanup leave a detached task's folder alone.
    expect(calls[0].params).toMatchObject({ taskId: 'wtask-k1', detach: true });
    expect(stopPanesIn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(worktreePath, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
    // By name: Windows lists the long form of a short (8.3) temp path.
    expect(git(['worktree', 'list', '--porcelain'], repoRoot)).toContain(path.basename(worktreePath));
    expect(store.get(worktreePath)).toBeNull();
    expect(forgetStops).toHaveBeenCalledWith(worktreePath);
  });

  it('keepFolder of a half-removed folder (leftoverPath) keeps it and ends its records', async () => {
    const left = path.join(wtBase, 'left-k2');
    fs.mkdirSync(left, { recursive: true });
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 });
    const forgetStops = vi.fn();
    const { port } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: store }), forgetStops });
    const res = await svc.closeTask({ taskId: 'wtask-k2', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: true, keptFolder: left });
    expect(fs.existsSync(left)).toBe(true);
    expect(store.all()).toEqual([]);
    expect(forgetStops).toHaveBeenCalledWith(left);
  });

  it('keepFolder ends the pending removal before the close, so a mission that does not close leaves an open task whose folder nothing deletes', async () => {
    const left = path.join(wtBase, 'left-k3');
    fs.mkdirSync(left, { recursive: true });
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 });
    const { port } = makeDaemon({ ok: false, error: { message: 'mission is gone' } });
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: store }) });
    const res = await svc.closeTask({ taskId: 'wtask-k3', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect(store.get(left)).toBeNull();
    expect(fs.existsSync(left)).toBe(true);
  });

  it('keepFolder waits for a close of the same task under way, and names no folder that close removed', async () => {
    const { worktreePath } = await makeWorktree('keep-race');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stopping!: () => void;
    const stopStarted = new Promise<void>((r) => { stopping = r; });
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager(), stopPanesIn: async () => { stopping(); await gate; return []; } });
    const removing = svc.closeTask({ taskId: 'wtask-k5', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath });
    await stopStarted;
    const keeping = svc.closeTask({ taskId: 'wtask-k5', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath, keepFolder: true });
    release();
    expect(await removing).toMatchObject({ ok: true });
    const kept = await keeping;
    // The keep ran after the first close: its detach close comes second.
    expect(calls.map((c) => c.params['detach'] === true)).toEqual([false, true]);
    expect(kept).toMatchObject({ ok: true, taskId: 'wtask-k5' });
    expect(kept).not.toHaveProperty('keptFolder');
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('keepFolder holds the task\'s folder against a bot task\'s cleanup while it closes, and says whether it kept it', async () => {
    const { worktreePath } = await makeWorktree('keep-hold');
    const events: string[] = [];
    const holdFolder = vi.fn(async (taskId: string) => {
      events.push(`hold ${taskId}`);
      return (kept: boolean) => { events.push(`release ${kept}`); };
    });
    const { port } = makeDaemon();
    const rpc = port.rpc as ReturnType<typeof vi.fn>;
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      events.push(method);
      return params['taskId'] === 'wtask-k7' ? { ok: true } : { ok: false, error: { message: 'mission is gone' } };
    });
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager(), holdFolder });
    expect(await svc.closeTask({ taskId: 'wtask-k7', verifiedWorkspaceId: 'ws-owner', worktreePath, keepFolder: true })).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(events).toEqual(['hold wtask-k7', 'task.mission.close', 'release true']);
    events.length = 0;
    expect(await svc.closeTask({ taskId: 'wtask-k8', verifiedWorkspaceId: 'ws-owner', worktreePath, keepFolder: true })).toMatchObject({ ok: false });
    expect(events).toEqual(['hold wtask-k8', 'task.mission.close', 'release false']);
  });

  it('a close queued behind a keep of the same task removes nothing', async () => {
    const { worktreePath } = await makeWorktree('keep-first');
    const stopPanesIn = vi.fn(async () => []);
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager(), stopPanesIn });
    const keeping = svc.closeTask({ taskId: 'wtask-k6', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath, keepFolder: true });
    const removing = svc.closeTask({ taskId: 'wtask-k6', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath });
    expect(await keeping).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(await removing).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(stopPanesIn).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['task.mission.close']);
  });

  it('keepFolder leaves the task open when the pending removal cannot be ended', async () => {
    const left = path.join(wtBase, 'left-k4');
    fs.mkdirSync(left, { recursive: true });
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 });
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('disk full'));
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: store }) });
    const res = await svc.closeTask({ taskId: 'wtask-k4', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: false, reason: 'error', preservedWorktree: left });
    expect(calls).toHaveLength(0);
    expect(store.get(left)).not.toBeNull();
  });
});
