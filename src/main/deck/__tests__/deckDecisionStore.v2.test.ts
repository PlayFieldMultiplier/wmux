// deckDecisionStore v2: many decisions per workspace, one per room thread. A
// v1 file reads as the `general` thread; the original API keeps its
// one-per-workspace behaviour on `general`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearDecision,
  clearThreadDecision,
  clearWorkspaceDecisions,
  getDeckDecisionPath,
  hasPendingDecision,
  isMainOwnedDecision,
  loadAllDeckDecisions,
  loadDeckDecisions,
  loadThreadDecision,
  loadWorkspaceDecision,
  loadWorkspaceDecisions,
  raiseDecisionIfFree,
  raiseThreadDecisionIfFree,
  resolveDecision,
  resolveThreadDecision,
} from '../deckDecisionStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-decision-v2-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const V1 = {
  'ws-1': { id: 'd-1', question: 'Ship it?', options: ['Yes', 'No'], context: '', status: 'pending', raisedAt: 5 },
};

describe('deckDecisionStore v2', () => {
  it('reads a v1 file as the general thread and rewrites it as v2 on the next write', async () => {
    writeFileSync(getDeckDecisionPath(dir), JSON.stringify(V1));
    expect(loadWorkspaceDecisions('ws-1', dir)).toEqual([
      { id: 'd-1', question: 'Ship it?', options: ['Yes', 'No'], context: '', status: 'pending', raisedAt: 5, threadId: 'general' },
    ]);
    expect(loadWorkspaceDecision('ws-1', dir)?.id).toBe('d-1');
    expect(hasPendingDecision('ws-1', dir)).toBe(true);

    await raiseThreadDecisionIfFree('ws-1', 'pr:a/b#7', { question: 'Merge anyway?', origin: 'ask_person', handoffId: 'h-1' }, dir);
    const raw = JSON.parse(readFileSync(getDeckDecisionPath(dir), 'utf8')) as Record<string, unknown>;
    // Keys stay workspace ids; values are now arrays.
    expect(Object.keys(raw)).toEqual(['ws-1']);
    expect(Array.isArray(raw['ws-1'])).toBe(true);
    expect((raw['ws-1'] as unknown[]).length).toBe(2);
  });

  it('holds one decision per thread; the original API sees only general', async () => {
    const threaded = await raiseThreadDecisionIfFree('ws-1', 'issue:a/b#3', { question: 'Repro on Windows?', origin: 'ask_person', handoffId: 'h-9' }, dir);
    expect(threaded).toMatchObject({ threadId: 'issue:a/b#3', handoffId: 'h-9', origin: 'ask_person', status: 'pending' });
    expect(isMainOwnedDecision(threaded)).toBe(true);
    // The general slot is still free for the original API…
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
    expect(loadDeckDecisions(dir)).toEqual({});
    const general = await raiseDecisionIfFree('ws-1', { question: 'Hand it off?' }, dir);
    expect(general?.threadId).toBe('general');
    // …and each slot is taken once.
    expect(await raiseThreadDecisionIfFree('ws-1', 'issue:a/b#3', { question: 'Again?' }, dir)).toBeNull();
    expect(await raiseDecisionIfFree('ws-1', { question: 'Again?' }, dir)).toBeNull();
    expect(loadWorkspaceDecisions('ws-1', dir).map((d) => d.threadId).sort()).toEqual(['general', 'issue:a/b#3']);
  });

  it('resolves by id in any thread; a stale resolve is a no-op', async () => {
    const d = await raiseThreadDecisionIfFree('ws-1', 'task:t-1', { question: 'Keep the worktree?', options: ['Keep', 'Drop'] }, dir);
    const resolved = await resolveThreadDecision('ws-1', d?.id ?? "", 'Keep', {}, dir);
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'Keep', resolvedBy: 'human', threadId: 'task:t-1' });
    expect(await resolveThreadDecision('ws-1', d?.id ?? "", 'Drop', {}, dir)).toBeNull();
    expect(await resolveThreadDecision('ws-1', 'nope', 'Drop', {}, dir)).toBeNull();
    // The original resolve addresses general only.
    const other = await raiseThreadDecisionIfFree('ws-1', 'task:t-2', { question: 'Q?' }, dir);
    expect(await resolveDecision('ws-1', other?.id ?? "", 'A', dir)).toBeNull();
  });

  it('clears one thread, the general thread, or every thread of a workspace', async () => {
    const a = await raiseThreadDecisionIfFree('ws-1', 'task:a', { question: 'A?' }, dir);
    await raiseThreadDecisionIfFree('ws-1', 'task:b', { question: 'B?' }, dir);
    await raiseDecisionIfFree('ws-1', { question: 'G?' }, dir);
    expect(await clearThreadDecision('ws-1', 'task:a', 'wrong-id', dir)).toBe(false);
    expect(await clearThreadDecision('ws-1', 'task:a', a?.id ?? "", dir)).toBe(true);
    expect(loadThreadDecision('ws-1', 'task:a', dir)).toBeNull();
    expect(loadWorkspaceDecisions('ws-1', dir)).toHaveLength(2);
    // The original clear (a loop reset) takes the general thread only.
    await clearDecision('ws-1', dir);
    expect(loadWorkspaceDecisions('ws-1', dir).map((d) => d.threadId)).toEqual(['task:b']);
    await clearWorkspaceDecisions('ws-1', dir);
    expect(loadWorkspaceDecisions('ws-1', dir)).toEqual([]);
    expect(loadAllDeckDecisions(dir)).toEqual({});
  });

  it('drops a record whose thread does not parse and keeps the first of two in one thread', () => {
    const q = (id: string, threadId?: unknown) => ({ id, question: 'Q', options: [], context: '', status: 'pending', raisedAt: 1, ...(threadId === undefined ? {} : { threadId }) });
    writeFileSync(getDeckDecisionPath(dir), JSON.stringify({
      'ws-1': [q('a', 'pr:a/b#1'), q('b', 'pr:nope'), q('c', 'pr:a/b#1'), q('d')],
    }));
    expect(loadWorkspaceDecisions('ws-1', dir).map((d) => [d.id, d.threadId])).toEqual([['a', 'pr:a/b#1'], ['d', 'general']]);
  });

  it('refuses a thread id that is not one', async () => {
    expect(await raiseThreadDecisionIfFree('ws-1', 'bogus' as never, { question: 'Q?' }, dir)).toBeNull();
    expect(loadWorkspaceDecisions('ws-1', dir)).toEqual([]);
  });
});
