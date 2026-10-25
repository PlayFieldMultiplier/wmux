// A scriptable stand-in for `codex app-server --listen stdio://`: a fake
// ChildProcess whose stdin JSON-RPC lines are recorded and whose stdout the
// test writes. It answers initialize, thread/start, thread/resume and
// turn/start by itself and exits when its stdin closes.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ChildBackend } from '../childBackend';

let nextPid = 3_950_000;

export const THREAD_ID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b';

export class FakeCodex {
  readonly stdin: Array<Record<string, unknown>> = [];
  args: string[] = [];
  /** The version initialize reports in its userAgent. */
  version = '0.162.1';
  /** Turns thread/resume reports. */
  resumeTurns: Array<Record<string, unknown>> = [];
  private turns = 0;
  private child: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; pid: number }) | null = null;

  backend(): ChildBackend {
    return new ChildBackend(
      (_command, args) => this.spawn(args),
      () => this.exit(null, 'SIGKILL'),
      () => undefined,
    );
  }

  private answer(line: Record<string, unknown>): void {
    const params = (line.params ?? {}) as Record<string, unknown>;
    if (line.method === 'initialize') {
      this.out({ id: line.id, result: { userAgent: `wmux_chat/${this.version} (Mac OS 15.6.0; arm64) dumb (wmux_chat; 1.0.0)`, codexHome: '/h', platformFamily: 'unix', platformOs: 'macos' } });
    } else if (line.method === 'thread/start') {
      this.out({ id: line.id, result: { thread: { id: THREAD_ID, turns: [] } } });
    } else if (line.method === 'thread/resume') {
      this.out({ id: line.id, result: { thread: { id: params.threadId, turns: this.resumeTurns } } });
    } else if (line.method === 'turn/start') {
      this.turns += 1;
      this.out({ id: line.id, result: { turn: { id: `turn-${this.turns}`, status: 'inProgress', items: [] } } });
    } else if (line.method === 'turn/interrupt') {
      this.out({ id: line.id, result: {} });
    }
  }

  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    this.args = args;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffer = '';
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
          buffer = buffer.slice(index + 1);
          this.stdin.push(line);
          if (typeof line.method === 'string' && line.id !== undefined) this.answer(line);
        }
        callback();
      },
    });
    stdin.on('finish', () => this.exit(0, null));
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: nextPid++, exitCode: null as number | null, signalCode: null });
    this.child = child;
    setImmediate(() => child.emit('spawn'));
    return child as unknown as ChildProcessWithoutNullStreams;
  }

  out(message: Record<string, unknown>): void {
    this.child?.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** A notification on the started thread. */
  note(method: string, params: Record<string, unknown>): void {
    this.out({ method, params: { threadId: THREAD_ID, turnId: `turn-${this.turns}`, ...params } });
  }

  /** A server request on the started thread. */
  request(id: number | string, method: string, params: Record<string, unknown>): void {
    this.out({ id, method, params: { threadId: THREAD_ID, turnId: `turn-${this.turns}`, ...params } });
  }

  /** Every reply written to server request `id`. */
  replies(id: number | string): Array<Record<string, unknown>> {
    return this.stdin.filter((line) => line.id === id && line.method === undefined);
  }

  /** Every client call of `method`. */
  calls(method: string): Array<Record<string, unknown>> {
    return this.stdin.filter((line) => line.method === method);
  }

  exit(code: number | null, signal: string | null): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.exitCode = code ?? -1;
    setImmediate(() => {
      child.emit('exit', code, signal);
      child.stdout.end();
      setImmediate(() => child.emit('close', code, signal));
    });
  }
}
