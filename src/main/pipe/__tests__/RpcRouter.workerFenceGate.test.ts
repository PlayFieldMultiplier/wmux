// A fenced bot worker's pane does not get the pipe methods behind the wmux
// tools its fence refuses, whichever pane hint the call carries; the rest of
// the pipe, and every other pane, are as before.

import { beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { WORKER_FENCE_REFUSED_RPC } from '../../../shared/botWorkerGuard';

let router: RpcRouter;
let reached: string[];
const FENCED = 'pty-fenced';

beforeEach(() => {
  router = new RpcRouter();
  reached = [];
  for (const m of [...WORKER_FENCE_REFUSED_RPC, 'input.readScreen', 'a2a.task.send']) {
    router.register(m as never, async () => {
      reached.push(m);
      return { ok: true };
    });
  }
  router.setFencedWorkerPty((pty) => pty === FENCED);
});

const call = (method: string, extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
  router.dispatch({ id: method, method: method as never, params, clientName: 'claude-code', ...extra }, { externalWire: true });

describe('the worker fence gate', () => {
  it('refuses the fenced methods to a fenced pane, by its envelope or its sender', async () => {
    for (const m of WORKER_FENCE_REFUSED_RPC) {
      const byEnvelope = await call(m, { callerPtyId: FENCED });
      expect(byEnvelope.ok, m).toBe(false);
      expect((byEnvelope as { error: string }).error).toBe(`${m}: not available inside the worker fence`);
      expect((await call(m, {}, { senderPtyId: FENCED })).ok, m).toBe(false);
    }
    expect(reached).toEqual([]);
  });

  it('lets a fenced pane read and message, and every other pane send', async () => {
    expect((await call('input.readScreen', { callerPtyId: FENCED })).ok).toBe(true);
    expect((await call('a2a.task.send', { callerPtyId: FENCED })).ok).toBe(true);
    expect((await call('input.send', { callerPtyId: 'pty-other' })).ok).toBe(true);
    expect(reached).toEqual(['input.readScreen', 'a2a.task.send', 'input.send']);
  });

  it('refuses when the check itself fails, and refuses nothing when unset', async () => {
    router.setFencedWorkerPty(() => {
      throw new Error('record unreadable');
    });
    expect((await call('pane.split', { callerPtyId: 'pty-other' })).ok).toBe(false);
    router.setFencedWorkerPty(undefined);
    expect((await call('pane.split', { callerPtyId: FENCED })).ok).toBe(true);
  });
});
