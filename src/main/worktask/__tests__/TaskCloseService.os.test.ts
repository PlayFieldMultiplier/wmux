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
import { deliberateSleep } from '../../../test-utils/waitFor';

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
      return closeResult ?? { ok: true, taskId: params['taskId'], ...(params['detach'] === true ? { detached: true } : {}) };
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
    return { worktrees: { finishPendingRemoval, pendingRemovalKept: () => false } as unknown as TaskWorktreeManager, finishPendingRemoval };
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
    // A folder that went is not kept: an ordinary close.
    expect(calls[0].params).not.toHaveProperty('detach');
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
});

// #2388: the ways out of a close that keeps refusing. Close and keep folder
// closes the task and leaves its folder as it is; a half-removed folder whose
// repository is gone can never be checked again, so its close keeps it.
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
    // Closed detached: the folder is the owner's, so no cleanup of closed
    // tasks (the bots' task folder cleanup) takes it.
    expect(calls[0].params).toMatchObject({ taskId: 'wtask-k1', detach: true });
    expect(stopPanesIn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(worktreePath, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
    expect(git(['worktree', 'list', '--porcelain'], repoRoot)).toContain(worktreePath.replace(/\\/g, '/'));
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

  it('keepFolder marks the pending removal kept on disk before the task closes, and keeps the task open when it cannot', async () => {
    const left = path.join(wtBase, 'left-k3');
    fs.mkdirSync(left, { recursive: true });
    const file = path.join(wtBase, 'wmux', 'worktask', 'pending-removals.json');
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 });
    const onDisk = (): unknown[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { removals: unknown[] }).removals;
    let atClose: unknown[] | null = null;
    const port: CloseDaemonPort = { rpc: vi.fn(async (_m, params) => { atClose = onDisk(); return { ok: true, taskId: params['taskId'], detached: true }; }) };
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: store }) });
    expect(await svc.closeTask({ taskId: 'wtask-k3', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true })).toMatchObject({ ok: true, keptFolder: left });
    // A restart right after the close would find the folder kept, never a
    // removal to finish; once the close is done the record ends.
    expect(atClose).toEqual([expect.objectContaining({ path: left, keep: true })]);
    expect(onDisk()).toEqual([]);

    // The record cannot be marked on disk: nothing is closed.
    const failing = { get: () => ({ path: left, repoRoot, repoHash: 'closehash', at: 1 }), all: () => [], put: async () => { throw new Error('EACCES: the store cannot be written'); }, delete: async () => undefined };
    const { port: port2, calls } = makeDaemon();
    const svc2 = new TaskCloseService({ daemon: port2, worktrees: new TaskWorktreeManager({ pendingRemovals: failing }) });
    const res = await svc2.closeTask({ taskId: 'wtask-k3b', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    if (!res.ok) expect(res.error).toMatch(/EACCES/);
    expect(calls).toHaveLength(0);
  });

  it('keepFolder of a task closed before (the daemon records no detach) promises no keep', async () => {
    const left = path.join(wtBase, 'left-k10');
    fs.mkdirSync(left, { recursive: true });
    const noteFolderKept = vi.fn(async () => undefined);
    // An already-closed task: the daemon acks the close without detached.
    const { port } = makeDaemon({ ok: true, taskId: 'wtask-k10' });
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) }), noteFolderKept });
    const res = await svc.closeTask({ taskId: 'wtask-k10', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    if (!res.ok) expect(res.error).toMatch(/already closed, so its folder cannot be marked kept/);
    expect(fs.existsSync(left)).toBe(true);
  });

  it('keepFolder refuses while the pending removals could not be read: one of the folder may be recorded there', async () => {
    const left = path.join(wtBase, 'left-k11');
    fs.mkdirSync(left, { recursive: true });
    const file = path.join(wtBase, 'wmux', 'worktask', 'pending-removals.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const store = new PendingWorktreeRemovals(file);
    expect(() => store.load()).toThrow();
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: store }) });
    const res = await svc.closeTask({ taskId: 'wtask-k11', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    if (!res.ok) expect(res.error).toMatch(/pending removals could not be read/);
    expect(calls).toHaveLength(0);
    // The unreadable file is never written over.
    await expect(store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 })).rejects.toThrow(/could not be read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    // Nor held in memory, as a lock no delete could ever end.
    expect(store.get(left)).toBeNull();
  });

  it('a keep whose close failed stays kept: the next close, any close, goes the keep way', async () => {
    const left = path.join(wtBase, 'left-k12');
    fs.mkdirSync(left, { recursive: true });
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot, repoHash: 'closehash', at: 1 });
    const mgr = new TaskWorktreeManager({ pendingRemovals: store });
    const refusing = makeDaemon({ ok: false, error: { message: 'daemon busy' } });
    const first = await new TaskCloseService({ daemon: refusing.port, worktrees: mgr }).closeTask({ taskId: 'wtask-k12', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(first).toMatchObject({ ok: false });
    expect(store.get(left)).toMatchObject({ keep: true });

    // A plain close of the task now: still the keep way, detached.
    const { port, calls } = makeDaemon();
    const finish = vi.spyOn(mgr, 'finishPendingRemoval');
    const res = await new TaskCloseService({ daemon: port, worktrees: mgr }).closeTask({ taskId: 'wtask-k12', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: true, keptFolder: left });
    expect(calls[0].params).toMatchObject({ detach: true });
    expect(finish).not.toHaveBeenCalled();
    expect(store.get(left)).toBeNull();
    expect(fs.existsSync(left)).toBe(true);
  });

  it('keepFolder holds and marks the task\'s folder for the bots\' cleanup even with no folder named', async () => {
    const holdTaskFolder = vi.fn(async () => () => undefined);
    const noteFolderKept = vi.fn(async () => undefined);
    const { port } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) }), holdTaskFolder, noteFolderKept });
    expect(await svc.closeTask({ taskId: 'wtask-k13', verifiedWorkspaceId: 'ws-owner', keepFolder: true })).toMatchObject({ ok: true });
    expect(holdTaskFolder).toHaveBeenCalledWith('wtask-k13');
    expect(noteFolderKept).toHaveBeenCalledWith('wtask-k13');
  });

  it('a keep whose close failed is remembered with no removal pending: a later plain close keeps the folder', async () => {
    const { worktreePath } = await makeWorktree('keep-r');
    const store = storeIn(wtBase);
    const mgr = new TaskWorktreeManager({ pendingRemovals: store });
    const refusing = makeDaemon({ ok: false, error: { message: 'daemon busy' } });
    const first = await new TaskCloseService({ daemon: refusing.port, worktrees: mgr }).closeTask({ taskId: 'wtask-kr', verifiedWorkspaceId: 'ws-owner', leftoverPath: worktreePath, keepFolder: true });
    expect(first).toMatchObject({ ok: false });
    expect(store.get(worktreePath)).toMatchObject({ keep: true });

    // The worktree is clean: a plain close would remove it. It keeps it.
    const remove = vi.spyOn(mgr, 'removeWorktree');
    const { port, calls } = makeDaemon();
    const res = await new TaskCloseService({ daemon: port, worktrees: mgr }).closeTask({ taskId: 'wtask-kr', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath });
    expect(res).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(calls[0].params).toMatchObject({ detach: true });
    expect(remove).not.toHaveBeenCalled();
    expect(store.get(worktreePath)).toBeNull();
    expect(fs.existsSync(path.join(worktreePath, 'a.txt'))).toBe(true);
  });

  it('keepFolder holds the folder before it waits on the bots\' cleanup', async () => {
    const left = path.join(wtBase, 'left-k14');
    fs.mkdirSync(left, { recursive: true });
    const mgr = new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) });
    const order: string[] = [];
    const hold = vi.spyOn(mgr, 'holdFolder');
    hold.mockImplementation(() => { order.push('hold folder'); return () => undefined; });
    const holdTaskFolder = vi.fn(async () => { order.push('hold task'); return () => undefined; });
    const { port } = makeDaemon();
    await new TaskCloseService({ daemon: port, worktrees: mgr, holdTaskFolder }).closeTask({ taskId: 'wtask-k14', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    expect(order.slice(0, 2)).toEqual(['hold folder', 'hold task']);
  });

  it('a close queued behind Close and keep folder removes nothing', async () => {
    const { worktreePath } = await makeWorktree('keep-q');
    const { port } = makeDaemon();
    const mgr = new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) });
    const remove = vi.spyOn(mgr, 'removeWorktree');
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });
    const keeping = svc.closeTask({ taskId: 'wtask-kq', verifiedWorkspaceId: 'ws-owner', leftoverPath: worktreePath, keepFolder: true });
    const removing = svc.closeTask({ taskId: 'wtask-kq', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'closehash', worktreePath });
    expect(await keeping).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(await removing).toMatchObject({ ok: true, keptFolder: worktreePath });
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktreePath, 'a.txt'))).toBe(true);
  });

  it('a close whose repository is gone fails, the task left open, when the folder cannot be marked kept on disk', async () => {
    const root = path.join(wtBase, 'root');
    const left = path.join(root, 'task-gone2');
    fs.mkdirSync(left, { recursive: true });
    const rec = { path: left, repoRoot: path.join(wtBase, 'moved-away'), repoHash: 'closehash', at: 1 };
    const failing = { get: () => rec, all: () => [rec], put: async () => { throw new Error('EACCES: the store cannot be written'); }, delete: async () => undefined };
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: failing }) });
    const res = await svc.closeTask({ taskId: 'wtask-k9', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: false, preservedWorktree: left });
    if (!res.ok) expect(res.error).toMatch(/could not be marked kept: EACCES/);
    expect(calls).toHaveLength(0);
  });

  it('keepFolder of a bot task holds its folder against the bots\' cleanup and marks it kept once closed', async () => {
    const left = path.join(wtBase, 'left-k7');
    fs.mkdirSync(left, { recursive: true });
    const order: string[] = [];
    const holdTaskFolder = vi.fn(async (id: string) => { order.push(`hold ${id}`); return () => { order.push('release'); }; });
    const noteFolderKept = vi.fn(async (id: string) => { order.push(`kept ${id}`); });
    const port: CloseDaemonPort = { rpc: vi.fn(async (_m, params) => { order.push('close'); return { ok: true, taskId: params['taskId'], detached: true }; }) };
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) }), holdTaskFolder, noteFolderKept });
    expect(await svc.closeTask({ taskId: 'wtask-k7', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true })).toMatchObject({ ok: true, keptFolder: left });
    // Marked before the close: no restart in between loses it.
    expect(order).toEqual(['hold wtask-k7', 'kept wtask-k7', 'close', 'release']);

    // A close the daemon refuses: the task stays open, its folder kept.
    order.length = 0;
    const refusing: CloseDaemonPort = { rpc: vi.fn(async () => ({ ok: false, error: { message: 'no' } })) };
    const svc2 = new TaskCloseService({ daemon: refusing, worktrees: new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) }), holdTaskFolder, noteFolderKept });
    expect(await svc2.closeTask({ taskId: 'wtask-k8', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true })).toMatchObject({ ok: false });
    expect(order).toEqual(['hold wtask-k8', 'kept wtask-k8', 'release']);

    // The cleanup's record cannot be dropped: nothing is closed.
    const { port: port3, calls } = makeDaemon();
    const svc3 = new TaskCloseService({ daemon: port3, worktrees: new TaskWorktreeManager({ pendingRemovals: storeIn(wtBase) }), holdTaskFolder, noteFolderKept: async () => { throw new Error('EACCES: task-folders.json'); } });
    expect(await svc3.closeTask({ taskId: 'wtask-k8b', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('a close of a task waits for the one already running for it: a keep asked during a removal never races it', async () => {
    const order: string[] = [];
    let finishRemove: () => void = () => undefined;
    const worktrees = {
      removeWorktree: vi.fn(async () => {
        order.push('remove start');
        await new Promise<void>((r) => { finishRemove = r; });
        order.push('remove end');
        return { ok: true };
      }),
      holdFolder: vi.fn(() => { order.push('hold'); return () => undefined; }),
      forgetPendingRemoval: vi.fn(async () => undefined),
      markPendingRemovalKept: vi.fn(async () => undefined),
      pendingRemovalKept: () => false,
    } as unknown as TaskWorktreeManager;
    const { port } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees });
    const removing = svc.closeTask({ taskId: 'wtask-k6', verifiedWorkspaceId: 'ws-owner', repoRoot, repoHash: 'h', worktreePath: path.join(wtBase, 'gone') });
    await vi.waitFor(() => expect(order).toContain('remove start'), { timeout: 5_000 });
    const keeping = svc.closeTask({ taskId: 'wtask-k6', verifiedWorkspaceId: 'ws-owner', leftoverPath: path.join(wtBase, 'gone'), keepFolder: true });
    await deliberateSleep(50, 'a negative check: the keep must not start while the removal runs');
    expect(order).toEqual(['remove start']);
    finishRemove();
    await removing;
    await keeping;
    expect(order).toEqual(['remove start', 'remove end', 'hold']);
  });

  it('keepFolder holds the folder from the start: a sweep that ends its checks while the close is asked deletes nothing', async () => {
    const root = path.join(wtBase, 'root');
    const left = path.join(root, 'task-held');
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, 'a.txt'), 'a\n');
    const store = storeIn(wtBase);
    const head = git(['rev-parse', 'HEAD'], repoRoot).trim();
    await store.put({ path: left, repoRoot, repoHash: 'closehash', head, at: 1 });
    // The sweep's git checks wait on a gate; the close RPC waits on another.
    let openChecks: () => void = () => undefined;
    const checks = new Promise<void>((r) => { openChecks = r; });
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args.includes('ls-files')) await checks;
      return { stdout: execFileSync('git', args, { cwd }).toString(), stderr: '' };
    });
    const removeTree = vi.fn(async (d: string) => { fs.rmSync(d, { recursive: true, force: true }); });
    const mgr = new TaskWorktreeManager({ runGit, worktreesRoot: root, removeTree, pendingRemovals: store });
    let answer: (v: unknown) => void = () => undefined;
    const port: CloseDaemonPort = { rpc: vi.fn(() => new Promise((r) => { answer = r; })) };
    const svc = new TaskCloseService({ daemon: port, worktrees: mgr });

    const sweeping = mgr.finishPendingRemoval(left);
    await vi.waitFor(() => expect(runGit.mock.calls.some(([a]) => a.includes('ls-files'))).toBe(true), { timeout: 10_000 });
    const closing = svc.closeTask({ taskId: 'wtask-k5', verifiedWorkspaceId: 'ws-owner', leftoverPath: left, keepFolder: true });
    openChecks();
    expect(await sweeping).toMatchObject({ ok: false, preserved: true });
    await vi.waitFor(() => expect(port.rpc).toHaveBeenCalled(), { timeout: 5_000 });
    answer({ ok: true, taskId: 'wtask-k5', detached: true });
    expect(await closing).toMatchObject({ ok: true, keptFolder: left });
    expect(removeTree).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(left, 'a.txt'))).toBe(true);
    expect(store.get(left)).toBeNull();
  });

  it('a half-removed folder whose repository is gone: the close keeps the folder, names it, and closes', async () => {
    const root = path.join(wtBase, 'root');
    const left = path.join(root, 'task-gone');
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, 'held.txt'), 'x\n');
    const store = storeIn(wtBase);
    await store.put({ path: left, repoRoot: path.join(wtBase, 'moved-away'), repoHash: 'closehash', at: 1 });
    const stopPanesIn = vi.fn(async () => []);
    const forgetStops = vi.fn();
    const { port, calls } = makeDaemon();
    const svc = new TaskCloseService({ daemon: port, worktrees: new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: store }), stopPanesIn, forgetStops });
    const res = await svc.closeTask({ taskId: 'wtask-k4', verifiedWorkspaceId: 'ws-owner', leftoverPath: left });
    expect(res).toMatchObject({ ok: true, keptFolder: left });
    expect(calls.map((c) => c.method)).toEqual(['task.mission.close']);
    expect(calls[0].params).toMatchObject({ detach: true });
    expect(stopPanesIn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(left, 'held.txt'), 'utf8')).toBe('x\n');
    expect(store.all()).toEqual([]);
    expect(forgetStops).toHaveBeenCalledWith(left);
  });
});
