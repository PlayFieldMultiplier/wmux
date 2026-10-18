import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installExitEvidence,
  noteExitReason,
  oneLineFrames,
  resetExitReasonsForTest,
  type ExitEvidenceProcess,
} from '../exitEvidence';

/** A process stand-in: listeners run when the test emits, nothing exits. */
function fakeProcess() {
  const em = new EventEmitter();
  return Object.assign(em, { pid: 4242 }) as unknown as ExitEvidenceProcess & EventEmitter;
}

function install(proc: ExitEvidenceProcess, over: { ignoreError?: (err: unknown) => boolean } = {}) {
  const lines: Array<{ level: string; msg: string }> = [];
  let clock = 1_000;
  installExitEvidence(proc, {
    log: (level, msg) => { lines.push({ level, msg }); },
    now: () => (clock += 5_000),
    ...over,
  });
  return lines;
}

beforeEach(() => resetExitReasonsForTest());

describe('exit line', () => {
  it('names the code, the noted reasons and the caller of process.exit', () => {
    const proc = fakeProcess();
    const lines = install(proc);
    noteExitReason('signal SIGTERM');
    noteExitReason('shutdown (SIGTERM)');
    function finishShutdownForTest(): void {
      proc.emit('exit', 0);
    }
    finishShutdownForTest();

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].msg).toMatch(/^\[exit\] daemon pid=4242 exiting code=0 reason=signal SIGTERM > shutdown \(SIGTERM\) uptime=5s caller=.*finishShutdownForTest/);
    // One line: the stack is collapsed.
    expect(lines[0].msg).not.toContain('\n');
  });

  it('says when nothing was noted', () => {
    const proc = fakeProcess();
    const lines = install(proc);
    proc.emit('exit', 1);
    expect(lines[0].msg).toContain('code=1 reason=none noted');
  });
});

describe('uncaught exceptions', () => {
  it('logs one the process will die of (no handler installed yet), with its stack', () => {
    const proc = fakeProcess();
    const lines = install(proc);
    const err = Object.assign(new Error('boom'), { code: 'EBOOM' });
    proc.emit('uncaughtExceptionMonitor', err, 'uncaughtException');
    proc.emit('exit', 1);

    expect(lines[0]).toMatchObject({ level: 'error' });
    expect(lines[0].msg).toMatch(/^\[exit\] fatal uncaughtException with no handler — the process exits: Error: boom code=EBOOM at /);
    expect(lines[1].msg).toContain('reason=fatal uncaughtException');
  });

  it('leaves one a handler takes to that handler', () => {
    const proc = fakeProcess();
    const lines = install(proc);
    proc.on('uncaughtException', () => { /* the daemon's own handler */ });
    proc.emit('uncaughtExceptionMonitor', new Error('handled'), 'uncaughtException');
    expect(lines).toEqual([]);
  });

  it('skips what the daemon already ignores on purpose', () => {
    const proc = fakeProcess();
    const lines = install(proc, { ignoreError: () => true });
    proc.emit('uncaughtExceptionMonitor', new Error('EPIPE'), 'uncaughtException');
    expect(lines).toEqual([]);
  });

  it('describes a thrown non-error value', () => {
    const proc = fakeProcess();
    const lines = install(proc);
    proc.emit('uncaughtExceptionMonitor', 'just a string', 'unhandledRejection');
    expect(lines[0].msg).toBe('[exit] fatal unhandledRejection with no handler — the process exits: non-error value: just a string');
  });
});

describe('diagnostic reports', () => {
  it('stay off on a Node with no excludeEnv setting, where assigning it would only add a plain property (Codex P1)', () => {
    const proc = fakeProcess();
    const report: { reportOnFatalError: boolean; directory: string; excludeEnv?: boolean } = { reportOnFatalError: false, directory: '' };
    proc.report = report;
    const lines: Array<{ level: string; msg: string }> = [];
    installExitEvidence(proc, { log: (level, msg) => { lines.push({ level, msg }); }, reportDir: '/never/created' });
    expect(report.reportOnFatalError).toBe(false);
    expect('excludeEnv' in report).toBe(false);
    expect(lines).toEqual([{ level: 'warn', msg: '[exit] diagnostic reports off: this Node cannot leave the environment out of them' }]);
  });

  it('stay off on a Node that cannot leave the environment out (it holds credentials)', () => {
    const proc = fakeProcess();
    const report = { reportOnFatalError: false, directory: '' };
    // An older Node: the excludeEnv setting does not exist and does not stick.
    Object.defineProperty(report, 'excludeEnv', { get: () => undefined, set: () => { /* unsupported */ } });
    proc.report = report;
    const lines: Array<{ level: string; msg: string }> = [];
    installExitEvidence(proc, { log: (level, msg) => { lines.push({ level, msg }); }, reportDir: '/never/created' });
    expect(report.reportOnFatalError).toBe(false);
    expect(lines).toEqual([{ level: 'warn', msg: '[exit] diagnostic reports off: this Node cannot leave the environment out of them' }]);
  });
});

describe('oneLineFrames', () => {
  it('drops Node-internal frames and the listener’s own', () => {
    const stack = [
      'Error',
      '    at process.<anonymous> (/x/exitEvidence.js:10:5)',
      '    at process.emit (node:events:514:28)',
      '    at process.exit (node:internal/process/per_thread:236:15)',
      '    at quit (/x/index.js:20:3)',
      '    at main (/x/index.js:30:1)',
    ].join('\n');
    expect(oneLineFrames(stack, 1)).toBe('quit (/x/index.js:20:3) < main (/x/index.js:30:1)');
    expect(oneLineFrames(undefined)).toBe('');
  });
});
