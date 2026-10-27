// The daemon's folder-trust verdict for a session, read from its own ring:
// what main falls back to when the renderer has no screen for the pane.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { folderTrustState, type FolderTrustDeps, type FolderTrustSession } from '../folderTrustState';
import { looksLikeFolderTrustDialog } from '../approvals/approvalKeystrokes';
import { enqueueSnapshotJob, generateTextSnapshot } from '../HeadlessSnapshot';
import { RingBuffer } from '../RingBuffer';
import { deliberateSleep } from '../../test-utils/waitFor';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import type { TerminalPty } from '../../shared/terminalPty';
import type { NativeOutputChunk } from '../../shared/nativeTerminalCore';

const fixtureRows = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../approvals/__tests__/fixtures/folder-trust', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen;

/** A full-screen TUI's frame: each row placed by cursor position, as Claude Code draws. */
const frame = (rows: string[]): Buffer =>
  Buffer.from(`\x1b[2J${rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('')}`);

/** A live session whose ring holds `bytes`, written at `cols`×`rows`. */
function session(bytes: Buffer, cols: number, rows: number, over: Partial<FolderTrustSession> = {}): FolderTrustSession & { ringBuffer: RingBuffer } {
  const ring = new RingBuffer(1024 * 1024);
  ring.noteGeometry(cols, rows);
  ring.write(bytes);
  return {
    meta: { state: 'attached', cols, rows },
    ptyProcess: { cols, rows },
    ringBuffer: ring,
    bridge: { isMuted: false, outputModes: null, heldOutput: () => null },
    ...over,
  } as FolderTrustSession & { ringBuffer: RingBuffer };
}

const deps = (s: FolderTrustSession | undefined, over: Partial<FolderTrustDeps> = {}): FolderTrustDeps => ({
  getSession: () => s,
  ...over,
});

const CLAUDE = fixtureRows('claude-folder-trust-120x40');

/** A recovered session at 120x40 whose real bridge is muted, its ring holding the restored screen. */
function mutedSession(restored: string) {
  let handler: ((chunk: NativeOutputChunk) => void) | undefined;
  const pty = {
    onData: vi.fn(),
    onNativeData: (cb: typeof handler) => { handler = cb; return { dispose: () => { handler = undefined; } }; },
    onExit: () => ({ dispose() { /* no process in this fixture */ } }),
    write: vi.fn(),
  } as unknown as TerminalPty;
  const ring = new RingBuffer(1024 * 1024, 'node');
  vi.spyOn(ring, 'writeNativeChunk').mockImplementation((chunk) => ring.write(Buffer.from(chunk.text)));
  ring.noteGeometry(120, 40);
  ring.write(Buffer.from(restored));
  const bridge = new DaemonPTYBridge();
  bridge.setupDataForwarding(pty, ring, 'muted-session');
  bridge.setMuted(true);
  cleanups.push(() => { bridge.cleanup(); ring.dispose(); });
  const s: FolderTrustSession & { resizedWhileMuted?: boolean } = {
    meta: { state: 'detached', cols: 120, rows: 40 },
    ptyProcess: { cols: 120, rows: 40 },
    ringBuffer: ring,
    bridge,
  };
  const feed = (text: string): void => handler?.({ text, byteLength: Buffer.byteLength(text), readBytes: () => Buffer.from(text), dispose: () => undefined } as unknown as NativeOutputChunk);
  return { session: s, bridge, ring, feed };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('folderTrustState', () => {
  it("is 'trust' when the ring's screen is the dialog", async () => {
    expect(await folderTrustState(deps(session(frame(CLAUDE), 120, 40)), 'pty-1')).toBe('trust');
    const codex = fixtureRows('codex-folder-trust-60x30');
    expect(await folderTrustState(deps(session(frame(codex), 60, 30)), 'pty-1')).toBe('trust');
  });

  it("is 'clear' for an ordinary screen, and for a dialog already answered", async () => {
    expect(await folderTrustState(deps(session(Buffer.from('⏺ Done.\r\n\r\n❯ '), 120, 40)), 'pty-1')).toBe('clear');
    // Measured after a daemon restart: the old dialog above a fresh shell prompt.
    const answered = Buffer.concat([frame(CLAUDE), Buffer.from(`\x1b[${CLAUDE.length + 1};1H% `)]);
    expect(await folderTrustState(deps(session(answered, 120, 40)), 'pty-1')).toBe('clear');
  });

  it('a dialog drawn at the spawn width, then a resize, is not read as clear', async () => {
    const s = session(frame(CLAUDE), 120, 40);
    s.ringBuffer.noteGeometry(60, 30);
    s.meta.cols = 60; s.meta.rows = 30;
    s.ptyProcess.cols = 60; s.ptyProcess.rows = 30;
    // Parsed whole at the new size, the cursor-placed rows overwrite each other.
    const naive = await generateTextSnapshot({ cols: 60, rows: 30, scrollback: 0, initial: s.ringBuffer.readAll() });
    expect(naive.ok && looksLikeFolderTrustDialog(naive.rows.map((r) => r.text))).toBe(false);
    expect(await folderTrustState(deps(s), 'pty-1')).not.toBe('clear');
  });

  it("is 'unknown' when cells the ring dropped could complete a dialog partly on screen", async () => {
    const ring = new RingBuffer(2048);
    ring.noteGeometry(120, 40);
    ring.write(frame(CLAUDE));
    // Only the grant choice is redrawn after the dialog's own draw left the ring.
    const yes = CLAUDE.findIndex((row) => row.includes('Yes, I trust this folder')) + 1;
    for (let n = 0; n < 80; n++) ring.write(Buffer.from(`\x1b[${yes};1H   Yes, I trust this folder`));
    const s = { ...session(Buffer.alloc(0), 120, 40), ringBuffer: ring };
    expect(await folderTrustState(deps(s), 'pty-1')).toBe('unknown');
  });

  it("is 'clear' when the cells it could not see belong to an ordinary screen", async () => {
    const ring = new RingBuffer(2048);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('\x1b[2J\x1b[1;1Hwritten long ago'));
    for (let n = 0; n < 200; n++) ring.write(Buffer.from(`\x1b[24;1H% tick ${n}`));
    const s = { ...session(Buffer.alloc(0), 80, 24), ringBuffer: ring };
    expect(await folderTrustState(deps(s), 'pty-1')).toBe('clear');
  });

  it('reads a ring larger than the tail window from its tail, within the budget', async () => {
    const ring = new RingBuffer(8 * 1024 * 1024);
    ring.noteGeometry(120, 40);
    for (let n = 0; n < 60_000; n++) ring.write(Buffer.from(`\x1b[${(n % 38) + 1};1H${'y'.repeat(100)}`));
    ring.write(frame(CLAUDE));
    expect(ring.size).toBeGreaterThan(3 * 1024 * 1024);
    const s = { ...session(Buffer.alloc(0), 120, 40), ringBuffer: ring };
    // A slower machine: a whole-ring parse outlasts the budget, a tail parse does not.
    const snapshot: NonNullable<FolderTrustDeps['snapshot']> = async (req) => {
      if (req.initial.length > 1024 * 1024) await deliberateSleep(400, 'a whole-ring parse on a slow machine, inside the stub');
      return generateTextSnapshot(req);
    };
    const started = Date.now();
    expect(await folderTrustState(deps(s, { snapshot }), 'pty-1')).toBe('trust');
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('joins a wrapped row whose cut fell on a blank with one space', async () => {
    // The read trims the blank the row ended in: "…you created" + "or one you trust?".
    const q = CLAUDE.findIndex((row) => row.includes('Quick safety check'));
    const rows = [
      ...CLAUDE.slice(0, q).map((text) => ({ text, wrapped: false })),
      { text: ' Quick safety check: Is this a project you created', wrapped: false },
      { text: 'or one you trust?', wrapped: true },
      ...CLAUDE.slice(q + 1).map((text) => ({ text, wrapped: false })),
    ];
    const snapshot = async () => ({ ok: true as const, rows });
    expect(await folderTrustState(deps(session(Buffer.from('x'), 120, 40), { snapshot }), 'pty-1')).toBe('trust');
  });

  it("is 'clear' without a read when nothing runs in the session", async () => {
    const snapshot = vi.fn();
    for (const state of ['suspended', 'dead'] as const) {
      const s = session(frame(CLAUDE), 120, 40, { meta: { state, cols: 120, rows: 40 } });
      expect(await folderTrustState(deps(s, { snapshot }), 'pty-1')).toBe('clear');
    }
    // Not held at all: a recovery placeholder, a record kept only on disk, a closed pane.
    expect(await folderTrustState(deps(undefined, { snapshot }), 'pty-gone')).toBe('clear');
    expect(snapshot).not.toHaveBeenCalled();
  });

  describe('a muted (recovered, not yet shown) session: ring and held output read together', () => {
    it("is 'trust' when the held output draws the dialog, and the unmute still releases it", async () => {
      const m = mutedSession('% old prompt\r\n');
      m.feed(frame(CLAUDE).toString());
      expect(m.ring.readAll().toString()).toBe('% old prompt\r\n');
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('trust');
      m.bridge.setMuted(false, { replayHeld: true });
      expect(m.ring.readAll().toString()).toContain('Yes, I trust this folder');
    });

    it("is 'clear' for a fresh shell, even over a restored dialog", async () => {
      const m = mutedSession(frame(CLAUDE).toString());
      m.feed(`\x1b[${CLAUDE.length + 1};1H% `);
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('clear');
    });

    it("is 'unknown' once the hold overflowed: its newest output, the screen, is missing", async () => {
      const m = mutedSession('');
      m.feed(frame(CLAUDE).toString());
      m.feed('x'.repeat(300 * 1024));
      expect(m.bridge.heldOutput()?.full).toBe(true);
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('unknown');
    });

    it("is 'unknown' after a resize while muted dropped the held output", async () => {
      const m = mutedSession('');
      m.feed(frame(CLAUDE).toString());
      m.bridge.discardHeld();
      m.session.resizedWhileMuted = true;
      expect(await folderTrustState(deps(m.session), 'pty-1')).toBe('unknown');
    });
  });

  it("is 'unknown' when the parse fails or the pane is resized during it", async () => {
    const s = session(frame(CLAUDE), 120, 40);
    expect(await folderTrustState(deps(s, { snapshot: async () => ({ ok: false }) }), 'pty-1')).toBe('unknown');
    const resized = async (req: Parameters<NonNullable<FolderTrustDeps['snapshot']>>[0]) => {
      s.ptyProcess.cols = 100;
      return generateTextSnapshot(req);
    };
    expect(await folderTrustState(deps(s, { snapshot: resized }), 'pty-1')).toBe('unknown');
  });

  it("is 'unknown' once a read outlasts 250 ms, and its result is dropped", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const snapshot = vi.fn(() => new Promise<{ ok: false }>((resolve) => { release = () => resolve({ ok: false }); }));
    const verdict = folderTrustState(deps(session(frame(CLAUDE), 120, 40), { snapshot }), 'pty-1');
    let settled: string | undefined;
    void verdict.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('unknown');
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('answers within its budget while the shared snapshot queue is busy', async () => {
    let unblock: (() => void) | undefined;
    const busy = enqueueSnapshotJob(() => new Promise<void>((resolve) => { unblock = resolve; }));
    try {
      const started = Date.now();
      expect(await folderTrustState(deps(session(frame(CLAUDE), 120, 40)), 'pty-1')).toBe('trust');
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      unblock?.();
      await busy;
    }
  });
});
