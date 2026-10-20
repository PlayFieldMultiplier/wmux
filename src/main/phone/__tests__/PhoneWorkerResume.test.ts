// main's side of the phone's worker Resume: the command's checks, main's
// result as the reply the daemon maps, and the receipts by caller and id.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPhoneWorkerResumeReceipts, handlePhoneWorkerResumeCommand, PHONE_WORKER_RESUME_RECEIPTS_MAX, type PhoneWorkerResumeDeps } from '../PhoneWorkerResume';
import type { WorkerResumeResult } from '../../factory/workerReclaim';

const NOW = 1_760_900_000_000;
const TASK = 'wtask-abc-12345678';
const id = (n = 0): string => `${NOW}-0a9b8c7d-6e5f-4a3b-8c2d-${String(n).padStart(12, '0')}`;
const OK: WorkerResumeResult = { ok: true, taskId: TASK, sessionId: 'daemon-1', resumeSessionId: 'conv-1', workspaceId: 'ws-task' };

function deps(result: WorkerResumeResult | (() => Promise<WorkerResumeResult>) = OK): PhoneWorkerResumeDeps & { resume: ReturnType<typeof vi.fn> } {
  return {
    resume: vi.fn(typeof result === 'function' ? result : async () => result),
    taskKnown: (taskId) => taskId === TASK,
    now: () => NOW,
    log: () => undefined,
  };
}

const call = (d: PhoneWorkerResumeDeps, payload: Record<string, unknown>) => handlePhoneWorkerResumeCommand('workspaces.workerResume', payload, d);

beforeEach(() => clearPhoneWorkerResumeReceipts());

describe('workspaces.workerResume', () => {
  it('answers only its own command, and checks the task and the request id first', async () => {
    const d = deps();
    expect(await handlePhoneWorkerResumeCommand('workspaces.botApproval', {}, d)).toBeNull();
    expect(await call(d, { taskId: 'nope', clientRequestId: id() })).toEqual({ notFound: true });
    expect(await call(d, { taskId: 'wtask-unknown', clientRequestId: id() })).toEqual({ notFound: true });
    expect(await call(d, { taskId: TASK, clientRequestId: 'x' })).toEqual({ invalid: true });
    // Outside its window: a forgotten receipt never runs a second resume.
    expect(await call(d, { taskId: TASK, clientRequestId: `${NOW - 11 * 60_000}-0a9b8c7d-6e5f-4a3b-8c2d-000000000000` })).toEqual({ invalid: true });
    expect(d.resume).not.toHaveBeenCalled();
  });

  it('maps main\'s result to the reply', async () => {
    expect(await call(deps(), { taskId: TASK, clientRequestId: id(1) })).toEqual({ resumed: { taskId: TASK, workspaceId: 'ws-task', sessionId: 'daemon-1' } });
    expect(await call(deps({ ok: false, code: 'no_slot', cap: 3, message: 'full' }), { taskId: TASK, clientRequestId: id(2) }))
      .toEqual({ refused: { code: 'no_slot', message: 'full', cap: 3 } });
    expect(await call(deps({ ok: false, code: 'already_running', message: 'up' }), { taskId: TASK, clientRequestId: id(3) }))
      .toEqual({ refused: { code: 'already_running', message: 'up' } });
    expect(await call(deps({ ok: false, code: 'not_started', message: 'off' }), { taskId: TASK, clientRequestId: id(4) })).toEqual({ unavailable: true });
  });

  it('a repeat replays the success, joins a request under way, and never resumes twice', async () => {
    let finish!: (r: WorkerResumeResult) => void;
    const d = deps(() => new Promise<WorkerResumeResult>((resolve) => { finish = resolve; }));
    const first = call(d, { taskId: TASK, clientRequestId: id(), deviceId: 'd1' });
    const joined = call(d, { taskId: TASK, clientRequestId: id(), deviceId: 'd1' });
    await Promise.resolve();
    finish(OK);
    expect(await first).toEqual({ resumed: { taskId: TASK, workspaceId: 'ws-task', sessionId: 'daemon-1' } });
    expect(await joined).toMatchObject({ replayed: true });
    expect(await call(d, { taskId: TASK, clientRequestId: id(), deviceId: 'd1' })).toMatchObject({ resumed: { taskId: TASK }, replayed: true });
    expect(d.resume).toHaveBeenCalledTimes(1);
    // The same id for another task, from the same caller, is refused.
    expect(await call(d, { taskId: 'wtask-other', clientRequestId: id(), deviceId: 'd1' })).toEqual({ idReused: true });
    // Another caller's id is its own.
    d.resume.mockResolvedValueOnce(OK);
    await call(d, { taskId: TASK, clientRequestId: id(), deviceId: 'd2' });
    expect(d.resume).toHaveBeenCalledTimes(2);
  });

  it('keys receipts by caller: the operator and a device sharing an id never replay or collide', async () => {
    const d = deps();
    expect(await call(d, { taskId: TASK, clientRequestId: id() })).toMatchObject({ resumed: { taskId: TASK } });
    // The device's same id is its own request: neither a replay nor a reuse.
    expect(await call(d, { taskId: 'wtask-other', clientRequestId: id(), deviceId: 'd1' })).toEqual({ notFound: true });
    d.resume.mockResolvedValueOnce({ ok: false, code: 'already_running', message: 'up' });
    expect(await call(d, { taskId: TASK, clientRequestId: id(), deviceId: 'd1' })).toEqual({ refused: { code: 'already_running', message: 'up' } });
    expect(d.resume).toHaveBeenCalledTimes(2);
    // A malformed device id never falls back to the operator's receipts.
    for (const deviceId of ['', 'bad id', 7, null]) {
      expect(await call(d, { taskId: TASK, clientRequestId: id(), deviceId })).toEqual({ invalid: true });
    }
    expect(d.resume).toHaveBeenCalledTimes(2);
  });

  it('settles a resume that does not answer in time, so a repeat is not held by it', async () => {
    const d = { ...deps(() => new Promise<WorkerResumeResult>(() => undefined)), waitMs: 5 };
    expect(await call(d, { taskId: TASK, clientRequestId: id() })).toEqual({ refused: { code: 'busy', message: 'the resume is still under way; try again in a moment' } });
    // Not kept: the repeat asks again (the resume's own lock answers it).
    d.resume.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'this worker is being resumed already' });
    expect(await call(d, { taskId: TASK, clientRequestId: id() })).toMatchObject({ refused: { code: 'busy' } });
    expect(d.resume).toHaveBeenCalledTimes(2);
  });

  it('a refusal is not kept: the same id runs the checks again', async () => {
    const d = deps();
    d.resume.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'later' });
    expect(await call(d, { taskId: TASK, clientRequestId: id() })).toEqual({ refused: { code: 'busy', message: 'later' } });
    expect(await call(d, { taskId: TASK, clientRequestId: id() })).toMatchObject({ resumed: { taskId: TASK } });
    expect(d.resume).toHaveBeenCalledTimes(2);
  });

  it('keeps a success for as long as its id is accepted, even an id stamped ahead of this clock', async () => {
    let now = NOW;
    const d = { ...deps(), now: () => now };
    const ahead = `${NOW + 30_000}-0a9b8c7d-6e5f-4a3b-8c2d-000000000001`;
    expect(await call(d, { taskId: TASK, clientRequestId: ahead })).toMatchObject({ resumed: { taskId: TASK } });
    now = NOW + 10 * 60_000 + 1;
    expect(await call(d, { taskId: TASK, clientRequestId: ahead })).toMatchObject({ replayed: true });
    now = NOW + 30_000 + 10 * 60_000;
    expect(await call(d, { taskId: TASK, clientRequestId: ahead })).toEqual({ invalid: true });
    expect(d.resume).toHaveBeenCalledTimes(1);
  });

  it('refuses a new request once the receipts are full', async () => {
    const d = deps();
    for (let n = 0; n < PHONE_WORKER_RESUME_RECEIPTS_MAX; n++) await call(d, { taskId: TASK, clientRequestId: id(n) });
    expect(await call(d, { taskId: TASK, clientRequestId: id(PHONE_WORKER_RESUME_RECEIPTS_MAX) })).toEqual({ full: true });
    // A repeat still replays.
    expect(await call(d, { taskId: TASK, clientRequestId: id(0) })).toMatchObject({ replayed: true });
  });
});
