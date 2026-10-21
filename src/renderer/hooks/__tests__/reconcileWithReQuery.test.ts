import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { heldSuspendedIds, holdsSuspendedSession, resolvePtyIdsToClear } from '../reconcileWithReQuery';

// RCA A1/A9 partial-list reconcile guard. The bug: a single partial daemon
// snapshot (mid-rehydrate) caused the reconcile to clear a live ptyId on the
// FIRST cycle, destroying a live session. These tests lock in the 2-strike
// contract: only clear ptyIds absent from BOTH snapshots, and PRESERVE
// everything on any uncertainty (re-query fails/throws, or the run aborts).

const noSleep = () => Promise.resolve();
const alwaysCurrent = () => true;
const noLog = () => { /* silent in tests */ };

describe('resolvePtyIdsToClear (RCA A1/A9 partial-list 2-strike guard)', () => {
  it('no candidates → returns empty set, never re-queries', async () => {
    const reList = vi.fn();
    const toClear = await resolvePtyIdsToClear([], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect(toClear.size).toBe(0);
    expect(reList).not.toHaveBeenCalled();
  });

  it('candidate reappears on re-query → NOT cleared (the whole point: live session survives a partial snapshot)', async () => {
    const reList = vi.fn(async () => ({ ok: true, ids: new Set(['pty-live']) }));
    const toClear = await resolvePtyIdsToClear(['pty-live'], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect(reList).toHaveBeenCalledTimes(1);
    expect(toClear.size).toBe(0);
  });

  it('candidate absent from BOTH snapshots → cleared exactly once', async () => {
    const reList = vi.fn(async () => ({ ok: true, ids: new Set(['other-pty']) }));
    const toClear = await resolvePtyIdsToClear(['pty-dead'], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect(toClear.has('pty-dead')).toBe(true);
    expect(toClear.size).toBe(1);
  });

  it('mixed — only ptyIds still absent on re-query are cleared; reappeared ones preserved', async () => {
    const reList = vi.fn(async () => ({ ok: true, ids: new Set(['a', 'c']) })); // b,d still missing
    const toClear = await resolvePtyIdsToClear(['a', 'b', 'c', 'd'], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect([...toClear].sort()).toEqual(['b', 'd']);
  });

  it('re-query returns !ok → zero clears (preserve all on uncertainty)', async () => {
    const reList = vi.fn(async () => ({ ok: false }));
    const toClear = await resolvePtyIdsToClear(['pty-1', 'pty-2'], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect(toClear.size).toBe(0);
  });

  it('re-query throws → zero clears (preserve all, no destructive decision on a thrown RPC)', async () => {
    const reList = vi.fn(async () => { throw new Error('pipe not writable'); });
    const toClear = await resolvePtyIdsToClear(['pty-1'], { reList, sleep: noSleep, isCurrent: alwaysCurrent, log: noLog });
    expect(toClear.size).toBe(0);
  });

  it('aborted before strike 2 → zero clears, never re-queries', async () => {
    const reList = vi.fn();
    const toClear = await resolvePtyIdsToClear(['pty-1'], { reList, sleep: noSleep, isCurrent: () => false, log: noLog });
    expect(toClear.size).toBe(0);
    expect(reList).not.toHaveBeenCalled();
  });

  it('aborted DURING the backoff (between strikes) → zero clears, never re-queries', async () => {
    const reList = vi.fn(async () => ({ ok: true, ids: new Set<string>() }));
    let alive = true;
    const sleep = vi.fn(async () => { alive = false; }); // torn down while backing off
    const toClear = await resolvePtyIdsToClear(['pty-1'], { reList, sleep, isCurrent: () => alive, log: noLog });
    expect(toClear.size).toBe(0);
    expect(reList).not.toHaveBeenCalled();
  });
});

// #2398 — the startup reconcile promoted every suspended session it found,
// on screen or not: a spawn per hidden pane at boot.
describe('holdsSuspendedSession', () => {
  it('holds a hidden pane’s suspended session (neither promoted nor cleared)', () => {
    expect(holdsSuspendedSession({ shown: false, stashed: false })).toBe(true);
  });

  it('promotes a shown pane’s, and a stashed pane’s as before', () => {
    expect(holdsSuspendedSession({ shown: true, stashed: false })).toBe(false);
    expect(holdsSuspendedSession({ shown: false, stashed: true })).toBe(false);
  });
});

// #2398 review item 1 — a suspended session a pane holds without promoting it
// is in use: the reconcile tells the daemon, which keeps it from aging out
// under the suspended TTL. That covers panes that never mount (a workspace
// outside the multiview grid), whose reconnect never runs.
describe('heldSuspendedIds', () => {
  it('names every examined binding the daemon lists suspended, and every pass hold, once', () => {
    const listed = [
      { id: 'pty-live', state: 'detached' },
      { id: 'pty-wsl', state: 'suspended' },
      { id: 'pty-not-ours', state: 'suspended' },
    ];
    expect(heldSuspendedIds(['pty-live', 'pty-wsl'], listed, ['pty-cap', 'pty-wsl'])).toEqual(['pty-wsl', 'pty-cap']);
    expect(heldSuspendedIds(['pty-live'], listed, [])).toEqual([]);
  });

  it('the startup reconcile sends them to the daemon once a pass completes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'Layout', 'AppLayout.tsx'), 'utf-8');
    const holdAt = source.indexOf('reconcile HOLDING suspended ptyId');
    expect(source.slice(holdAt, holdAt + 300)).toMatch(/heldByPass\.push\(candidate\.ptyId\);\s*continue;/);
    const sendAt = source.indexOf('const held = heldSuspendedIds(examinedPtyIds, listedPtys, heldByPass);');
    expect(sendAt).toBeGreaterThan(holdAt);
    expect(source.slice(sendAt, sendAt + 300)).toMatch(/window\.electronAPI\.pty\.hold\(held\)/);
    // Only after a pass that was not aborted.
    expect(source.slice(source.lastIndexOf('if (!signal?.aborted) {', sendAt), sendAt)).toMatch(/setPtysUnconfirmed/);
  });
});
