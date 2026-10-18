import { spawn, type ChildProcess } from 'node:child_process';
import type { Probe, ProbeAnswer, ProbeIo } from './gitContextWatch';

/**
 * #2407 — reads for the git watcher, off this process's fs threadpool.
 *
 * A read on a WSL share waits on the distro's 9P server. Done here, a hung one
 * holds one of libuv's four fs threads until the server answers, and no
 * deadline or cancel can free it: four hung distros would stall every fs call
 * the daemon (or main) makes. So a share's reads go to a small reader process
 * per distro, which is simply killed when a read misses its deadline and is
 * started again on the next read. A worker thread would not do: the pool is
 * per process.
 *
 * Each reader is a queue: one read at a time is handed to its process, so a
 * wedged distro parks one read, not a pile of them. A read whose caller no
 * longer wants it (the pane closed or moved on) leaves the queue at once and
 * is never handed over.
 */
export interface ProbeReader {
  /**
   * Answers `probe` once the reads queued before it are done. Rejects at once
   * when `signal` aborts (the caller no longer wants it: a queued read is
   * taken out of the queue, one being read is let go), and when the read
   * misses its deadline or the reader dies.
   */
  read(probe: Probe, signal?: AbortSignal): Promise<ProbeAnswer>;
  /** Reads asked for and still wanted: queued, or being read. */
  readonly outstanding: number;
  /** Rejects every read and stops the reader for good. */
  close(): void;
}

/** A reader for one share (a distro name), or for every other path (''). */
export type ProbeReaderFactory = (share: string) => ProbeReader;

/**
 * How long one read may take, from when it is handed over (not from when it
 * was queued), before it fails and the reader's process is replaced.
 */
export const SHARE_READ_DEADLINE_MS = 5_000;

interface QueuedRead {
  probe: Probe;
  resolve(answer: ProbeAnswer): void;
  reject(error: Error): void;
}

/**
 * The queue every reader shares; a subclass says how one read is answered
 * (`ask`) and what is done with a read that missed its deadline (`abandon`).
 */
abstract class QueuedProbeReader implements ProbeReader {
  private queue: QueuedRead[] = [];
  /** The read handed over, or null once it is let go (its caller cancelled). */
  private reading: QueuedRead | null = null;
  /** A read is handed over and has neither answered nor missed its deadline. */
  private busy = false;
  private deadline: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deadlineMs: number) {}

  get outstanding(): number {
    return this.queue.length + (this.reading ? 1 : 0);
  }

  read(probe: Probe, signal?: AbortSignal): Promise<ProbeAnswer> {
    if (this.closed) return Promise.reject(new Error('reader closed'));
    if (signal?.aborted) return Promise.reject(new Error('read cancelled'));
    return new Promise<ProbeAnswer>((resolve, reject) => {
      const onAbort = () => {
        const at = this.queue.indexOf(entry);
        if (at >= 0) this.queue.splice(at, 1);
        else if (this.reading === entry) this.reading = null;
        else return;
        reject(new Error('read cancelled'));
      };
      const done = () => signal?.removeEventListener('abort', onAbort);
      const entry: QueuedRead = {
        probe,
        resolve: (answer) => { done(); resolve(answer); },
        reject: (error) => { done(); reject(error); },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
      this.next();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.deadline) clearTimeout(this.deadline);
    const reason = new Error('reader closed');
    const reading = this.reading;
    this.reading = null;
    for (const entry of [...(reading ? [reading] : []), ...this.queue.splice(0)]) entry.reject(reason);
    this.stop();
  }

  /** Answers one read. Called with at most one read out at a time. */
  protected abstract ask(probe: Probe): Promise<ProbeAnswer>;
  /** The read handed over missed its deadline: give up on whatever is reading it. */
  protected abstract abandon(): void;
  /** Stops for good: the reader was closed. */
  protected abstract stop(): void;

  private next(): void {
    if (this.busy || this.closed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.busy = true;
    this.reading = entry;
    let over = false;
    const finish = (settle: (entry: QueuedRead) => void) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      this.deadline = null;
      this.busy = false;
      // Let go (cancelled) or closed meanwhile: nobody waits on the answer.
      if (this.reading === entry) {
        this.reading = null;
        settle(entry);
      }
      this.next();
    };
    const timer = setTimeout(() => {
      if (over) return;
      this.abandon();
      finish((e) => e.reject(new Error(`no answer within ${this.deadlineMs} ms`)));
    }, this.deadlineMs);
    timer.unref?.();
    this.deadline = timer;
    let asked: Promise<ProbeAnswer>;
    try {
      asked = this.ask(entry.probe);
    } catch (err) {
      asked = Promise.reject(err);
    }
    asked.then(
      (answer) => finish((e) => e.resolve(answer)),
      (error: unknown) => finish((e) => e.reject(error instanceof Error ? error : new Error(String(error)))),
    );
  }
}

/**
 * The reader process. Requests and answers are one JSON object per line,
 * `{id, op, path}` → `{id, answer}`; a path is only ever data, never part of
 * the script. Answers follow the watcher's ProbeAnswer contract. It exits
 * when its stdin closes, so a parent that dies leaves no reader behind.
 */
export const SHARE_READER_SOURCE = `
'use strict';
const fs = require('fs');
const kind = (st) => (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other');
async function answer(op, p) {
  try {
    if (op === 'read') return await fs.promises.readFile(p, 'utf8');
    if (op === 'realpath') return await fs.promises.realpath(p);
    return kind(await fs.promises.stat(p));
  } catch (err) {
    if (op !== 'stat') return null;
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'missing' : 'error';
  }
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (let i = pending.indexOf('\\n'); i >= 0; i = pending.indexOf('\\n')) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (!req || typeof req.path !== 'string') continue;
    answer(req.op, req.path).then((a) => process.stdout.write(JSON.stringify({ id: req.id, answer: a }) + '\\n'));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
`;

/**
 * This process's own runtime as plain node, the way the app runs its other
 * helpers: Electron (the daemon's and main's runtime) honours
 * ELECTRON_RUN_AS_NODE, which the RunAsNode fuse keeps available in the
 * packaged app, and a plain node binary ignores it.
 */
function readerCommand(): { command: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  return { command: process.execPath, env };
}

/** A reader process for one share, started on first use (see ProbeReader). */
export class ChildProbeReader extends QueuedProbeReader {
  private child: ChildProcess | null = null;
  /** Bumped whenever the process is let go: a retired one is never listened to. */
  private generation = 0;
  private nextId = 0;
  private waiting: { id: number; resolve(answer: ProbeAnswer): void; reject(error: Error): void } | null = null;
  /** Processes started so far — observability/testing only. */
  starts = 0;
  /** Processes killed for a missed deadline — observability/testing only. */
  kills = 0;

  constructor(
    deadlineMs = SHARE_READ_DEADLINE_MS,
    private readonly source = SHARE_READER_SOURCE,
  ) {
    super(deadlineMs);
  }

  /** The live process's pid, if one is running — testing only. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  protected ask(probe: Probe): Promise<ProbeAnswer> {
    const child = this.child ?? this.start();
    const id = ++this.nextId;
    return new Promise<ProbeAnswer>((resolve, reject) => {
      this.waiting = { id, resolve, reject };
      child.stdin?.write(`${JSON.stringify({ id, op: probe.op, path: probe.path })}\n`);
    });
  }

  /**
   * The process is stuck in the share. Kill it and forget it; the next read
   * starts a new one. Not waiting for its exit on purpose: a process parked
   * in 9P I/O can stay in a terminating state until that I/O returns.
   */
  protected abandon(): void {
    if (!this.child) return;
    this.kills++;
    this.retire(new Error('reader replaced after a missed deadline'));
  }

  protected stop(): void {
    this.retire(new Error('reader closed'));
  }

  private start(): ChildProcess {
    const generation = ++this.generation;
    const { command, env } = readerCommand();
    const child = spawn(command, ['-e', this.source], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    this.starts++;
    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (generation !== this.generation) return;
      buffered += chunk;
      for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        let reply: { id?: unknown; answer?: unknown };
        try { reply = JSON.parse(line) as typeof reply; } catch { continue; }
        const waiting = this.waiting;
        if (waiting && reply.id === waiting.id) {
          this.waiting = null;
          waiting.resolve(reply.answer as ProbeAnswer);
        }
      }
    });
    // After a kill, the next write can hit a closed pipe.
    child.stdin?.on('error', () => undefined);
    const gone = () => {
      if (generation !== this.generation) return;
      this.retire(new Error('reader exited'));
    };
    child.on('exit', gone);
    child.on('error', gone);
    // Never what keeps this process alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    return child;
  }

  /** Lets the process go (killing only this one, by its handle) and fails its read. */
  private retire(reason: Error): void {
    const child = this.child;
    const waiting = this.waiting;
    this.child = null;
    this.waiting = null;
    this.generation++;
    waiting?.reject(reason);
    try { child?.kill(); } catch { /* already gone */ }
  }
}

/**
 * The same contract for a path off any share (a host drive), answered in this
 * process: local disk does not hang the pool the way a share can. Also the
 * test seam: `answer` is any ProbeIo.
 */
export class InProcessProbeReader extends QueuedProbeReader {
  constructor(
    private readonly answer: ProbeIo,
    deadlineMs = SHARE_READ_DEADLINE_MS,
  ) {
    super(deadlineMs);
  }

  protected ask(probe: Probe): Promise<ProbeAnswer> {
    return this.answer(probe);
  }

  protected abandon(): void {
    // Nothing to stop: the read is this process's own, and its answer is dropped.
  }

  protected stop(): void {
    // Likewise.
  }
}
