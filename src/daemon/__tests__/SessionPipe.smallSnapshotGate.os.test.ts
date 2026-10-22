// #2585 follow-up: a new pane's small, resized ring skips the snapshot queue,
// but every such parse builds a headless terminal with MAX_SCROLLBACK rows.
// When many panes reattach at once (a daemon restart) those parses must stay
// under the small-ring gate, still never wait behind the queue, and all finish.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionPipe, createSessionPipeMarkers } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { waitFor, deliberateSleep } from '../../test-utils/waitFor';
// The mock below is hoisted above this import: these are the real functions.
import { enqueueSnapshotJob, runSmallSnapshotJob, SMALL_SNAPSHOT_CONCURRENCY } from '../HeadlessSnapshot';
import { ATTACH_SNAPSHOT_MIN_BYTES } from '../../shared/terminal/attachSnapshot';

// Count the attach parses SessionPipe runs, and hold each one until the test
// lets it go, so overlapping parses are observable. Count the small-gate
// entries too, so a flush parked at the gate is observable.
const parses = vi.hoisted(() => ({ running: 0, peak: 0, started: 0, gateEntries: 0, release: null as Promise<void> | null }));
vi.mock('../HeadlessSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HeadlessSnapshot')>();
  return {
    ...actual,
    runSmallSnapshotJob: <T>(job: () => Promise<T>): Promise<T> => {
      parses.gateEntries++;
      return actual.runSmallSnapshotJob(job);
    },
    generateSnapshotUnqueued: async (req: Parameters<typeof actual.generateSnapshotUnqueued>[0]) => {
      parses.running++;
      parses.started++;
      parses.peak = Math.max(parses.peak, parses.running);
      try {
        if (parses.release) await parses.release;
        return await actual.generateSnapshotUnqueued(req);
      } finally {
        parses.running--;
      }
    },
  };
});

const TOKEN = 'small-gate-test-token';
const FLUSH_DONE_MARKER = createSessionPipeMarkers(TOKEN).flushDone;
const COLS = 100;
const ROWS = 24;

interface Client {
  socket: net.Socket;
  wire: () => Buffer;
}

function connectClient(pipeName: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(pipeName, () => {
      socket.write(TOKEN + '\n');
      resolve({ socket, wire: () => Buffer.concat(chunks) });
    });
    socket.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on('error', reject);
  });
}

const pipes: SessionPipe[] = [];
const clients: Client[] = [];
// See SessionPipe.attachSnapshot.os.test.ts: short socket paths on macOS.
const socketDir = process.platform === 'darwin' ? fs.mkdtempSync('/tmp/wmux-sg-') : null;

afterAll(() => {
  if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
});

afterEach(async () => {
  parses.running = 0;
  parses.peak = 0;
  parses.started = 0;
  parses.gateEntries = 0;
  for (const c of clients.splice(0)) c.socket.destroy();
  for (const p of pipes.splice(0)) await p.stop().catch(() => { /* already stopped */ });
});

/** A new pane's ring: the preamble at the create-time size, then the first
 *  fit's resize and the shell's banner. */
function newPaneRing(n: number): RingBuffer {
  const ring = new RingBuffer(1024 * 1024);
  ring.noteGeometry(80, ROWS);
  ring.write(Buffer.from('\x1b[1t\x1b[?1004h\x1b[?9001h'));
  ring.noteGeometry(COLS, ROWS);
  ring.write(Buffer.from(`pane ${n}\r\n`));
  return ring;
}

describe('SessionPipe small-ring attach parses', () => {
  it(`never run more than ${SMALL_SNAPSHOT_CONCURRENCY} at once, and every pane flushes while the queue is held`, async () => {
    let releaseQueue!: () => void;
    const queueHolder = enqueueSnapshotJob(() => new Promise<void>((resolve) => { releaseQueue = resolve; }));
    await waitFor(() => typeof releaseQueue === 'function');
    let releaseParses!: () => void;
    parses.release = new Promise<void>((resolve) => { releaseParses = resolve; });
    const total = SMALL_SNAPSHOT_CONCURRENCY * 2 + 1;
    try {
      for (let i = 0; i < total; i++) {
        const id = `smallgate-${i}-${crypto.randomUUID().slice(0, 8)}`;
        const pipe = new SessionPipe(id, newPaneRing(i), TOKEN, () => ({ cols: COLS, rows: ROWS }));
        if (socketDir) vi.spyOn(pipe, 'getPipeName').mockReturnValue(path.join(socketDir, `${id}.sock`));
        pipes.push(pipe);
        await pipe.start();
        clients.push(await connectClient(pipe.getPipeName()));
      }
      // Every pane has asked to flush; only the gate's worth may be parsing.
      await waitFor(() => parses.started >= SMALL_SNAPSHOT_CONCURRENCY, 5_000);
      await deliberateSleep(100, 'an absence: no parse past the gate starts while the others hold');
      expect(parses.running).toBe(SMALL_SNAPSHOT_CONCURRENCY);

      releaseParses();
      await waitFor(() => clients.every((c) => c.wire().includes(FLUSH_DONE_MARKER)), 10_000);
      expect(parses.started).toBe(total);
      expect(parses.peak).toBe(SMALL_SNAPSHOT_CONCURRENCY);
    } finally {
      parses.release = null;
      releaseParses?.();
      releaseQueue();
      await queueHolder;
    }
  });

  it('a ring that grows past the bar while it waits for the gate is parsed in the queue', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    };
    // Another pane's large snapshot holds the queue; other small parses fill the gate.
    const queue = deferred();
    const queueHolder = enqueueSnapshotJob(() => queue.promise);
    const gate = deferred();
    const gateHolders = Array.from({ length: SMALL_SNAPSHOT_CONCURRENCY }, () => runSmallSnapshotJob(() => gate.promise));
    try {
      const id = `smallgate-grow-${crypto.randomUUID().slice(0, 8)}`;
      const ring = newPaneRing(0);
      const pipe = new SessionPipe(id, ring, TOKEN, () => ({ cols: COLS, rows: ROWS }));
      if (socketDir) vi.spyOn(pipe, 'getPipeName').mockReturnValue(path.join(socketDir, `${id}.sock`));
      pipes.push(pipe);
      await pipe.start();
      const client = await connectClient(pipe.getPipeName());
      clients.push(client);
      // The flush checked the (small) size and parked at the gate.
      await waitFor(() => parses.gateEntries === SMALL_SNAPSHOT_CONCURRENCY + 1, 5_000);

      // Output lands meanwhile: the ring is no longer small.
      const line = Buffer.from(`${'x'.repeat(COLS - 2)}
`);
      while (ring.size < ATTACH_SNAPSHOT_MIN_BYTES + 64 * 1024) ring.write(line);

      gate.resolve();
      await Promise.all(gateHolders);
      await deliberateSleep(150, 'an absence: no parse starts while the queue is held');
      expect(parses.started).toBe(0);
      expect(client.wire().includes(FLUSH_DONE_MARKER)).toBe(false);

      queue.resolve();
      await waitFor(() => client.wire().includes(FLUSH_DONE_MARKER), 15_000);
      expect(parses.started).toBe(1);
    } finally {
      gate.resolve();
      queue.resolve();
      await queueHolder;
    }
  });
});
