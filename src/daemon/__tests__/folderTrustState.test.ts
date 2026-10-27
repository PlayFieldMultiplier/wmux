// The daemon's folder-trust verdict for a session, read from its own ring:
// what main falls back to when the renderer has no screen for the pane.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { folderTrustState, type FolderTrustDeps, type FolderTrustSession } from '../folderTrustState';
import type { TextSnapshotOutcome } from '../HeadlessSnapshot';

const fixtureRows = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../approvals/__tests__/fixtures/folder-trust', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

const parsed = (rows: string[]): TextSnapshotOutcome => ({
  ok: true,
  rows: rows.map((text) => ({ text, wrapped: false })),
  bufferType: 'normal',
  rowsBelowCursor: 0,
  bytesIn: 0,
  durationMs: 1,
});

const live = (over: Partial<FolderTrustSession> = {}): FolderTrustSession => ({
  meta: { state: 'attached' },
  deferred: false,
  bridge: { isMuted: false },
  ...over,
});

function deps(session: FolderTrustSession | undefined, read: FolderTrustDeps['readScreen'], pending = false): FolderTrustDeps & { reads: number } {
  const d = {
    reads: 0,
    getSession: () => session,
    isPendingRecovery: () => pending,
    readScreen: (id: string) => {
      d.reads++;
      return read(id);
    },
  };
  return d;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('folderTrustState', () => {
  it.each(['claude-folder-trust-120x40', 'codex-folder-trust-60x30'])("is 'trust' when the ring's screen is the dialog (%s)", async (name) => {
    expect(await folderTrustState(deps(live(), async () => parsed(fixtureRows(name))), 'pty-1')).toBe('trust');
  });

  it("is 'clear' for an ordinary screen, and for a dialog an answer has already scrolled past", async () => {
    expect(await folderTrustState(deps(live(), async () => parsed(['⏺ Done.', '', '❯ '])), 'pty-1')).toBe('clear');
    // Measured after a daemon restart: the old dialog above a fresh shell prompt.
    const answered = [...fixtureRows('claude-folder-trust-60x30'), '% '];
    expect(await folderTrustState(deps(live({ meta: { state: 'detached' } }), async () => parsed(answered)), 'pty-1')).toBe('clear');
  });

  it("is 'clear' without a read when nothing runs in the session", async () => {
    for (const state of ['suspended', 'dead'] as const) {
      const d = deps(live({ meta: { state } }), async () => parsed(fixtureRows('claude-folder-trust-60x30')));
      expect(await folderTrustState(d, 'pty-1')).toBe('clear');
      expect(d.reads).toBe(0);
    }
    expect(await folderTrustState(deps(undefined, async () => null, true), 'pty-1')).toBe('clear');
  });

  it("is 'unknown' for a session it does not know", async () => {
    expect(await folderTrustState(deps(undefined, async () => null), 'pty-gone')).toBe('unknown');
  });

  it("is 'unknown' while recovered output is muted: the ring has not seen it", async () => {
    for (const session of [live({ deferred: true }), live({ bridge: { isMuted: true } })]) {
      const d = deps(session, async () => parsed(['% ']));
      expect(await folderTrustState(d, 'pty-1')).toBe('unknown');
      expect(d.reads).toBe(0);
    }
  });

  it("is 'unknown' when the parse fails, throws or finds the session gone", async () => {
    expect(await folderTrustState(deps(live(), async () => ({ ok: false, reason: 'budget' }) as TextSnapshotOutcome), 'pty-1')).toBe('unknown');
    expect(await folderTrustState(deps(live(), async () => { throw new Error('boom'); }), 'pty-1')).toBe('unknown');
    expect(await folderTrustState(deps(live(), async () => null), 'pty-1')).toBe('unknown');
  });

  it("is 'unknown' once a read outlasts 250 ms", async () => {
    vi.useFakeTimers();
    const verdict = folderTrustState(deps(live(), () => new Promise<TextSnapshotOutcome | null>(() => undefined)), 'pty-1');
    let settled: string | undefined;
    void verdict.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('unknown');
  });
});

describe('daemon.folderTrustState wiring', () => {
  it('answers from folderTrustState over the pane screen parse', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    const start = src.indexOf("pipeServer.onRpc('daemon.folderTrustState'");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('  });', start));
    expect(body).toContain('state: await folderTrustState({');
    expect(body).toContain('readScreen: (sid) => queuedScreenText(sessionManager, sid)');
  });
});
