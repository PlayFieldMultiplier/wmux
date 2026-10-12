import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../pipe/RpcRouter';
import {
  __resetFactoryModulesForTesting,
  registerFactoryRpc,
  registerFactoryRpcModule,
  registeredFactoryModules,
  type FactoryHostDeps,
} from '../factoryHost';
import { FACTORY_RPC_METHODS } from '../../../shared/botSurface';
import { factoryMigrationMarkerPath } from '../migrate';

let dir = '';

function deps(): FactoryHostDeps {
  return {
    getMainWindow: () => null,
    getDaemonClient: () => null,
    fanOutService: {} as FactoryHostDeps['fanOutService'],
    invokeRendererRpc: async () => undefined,
    resolvePtyWorkspace: async () => null,
    paneCwd: () => '',
    wmuxDir: () => dir,
  };
}

function operatorCall(router: RpcRouter, method: string, params: Record<string, unknown> = {}) {
  return router.dispatch({ id: 't', method: method as never, params }, { operator: true });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-factory-host-'));
  __resetFactoryModulesForTesting();
});

afterEach(() => {
  __resetFactoryModulesForTesting();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('registerFactoryRpc', () => {
  it('registers every factory method; an unimplemented one answers a typed not_implemented', async () => {
    const router = new RpcRouter();
    registerFactoryRpc(router, deps());
    const registered = new Set(router.getRegisteredMethods());
    for (const m of FACTORY_RPC_METHODS) expect(registered.has(m), m).toBe(true);
    const res = await operatorCall(router, 'room.post');
    expect(res).toEqual({
      id: 't',
      ok: true,
      result: { ok: false, code: 'not_implemented', method: 'room.post', message: 'room.post is not available in this build' },
    });
  });

  it('a module\'s handler replaces the stub; start and dispose run in order', async () => {
    const calls: string[] = [];
    registerFactoryRpcModule('rooms', (router) => {
      router.register('room.post', async () => ({ ok: true, card: 'c1' }));
      return { start: () => { calls.push('start rooms'); }, dispose: () => { calls.push('dispose rooms'); } };
    });
    registerFactoryRpcModule('facts', () => ({ start: () => { calls.push('start facts'); }, dispose: () => { calls.push('dispose facts'); } }));
    expect(registeredFactoryModules()).toEqual(['rooms', 'facts']);
    const router = new RpcRouter();
    const host = registerFactoryRpc(router, deps());
    expect(host.modules).toEqual(['rooms', 'facts']);
    expect(await operatorCall(router, 'room.post')).toMatchObject({ ok: true, result: { ok: true, card: 'c1' } });
    await host.start();
    await host.start();
    await host.dispose();
    await host.dispose();
    expect(calls).toEqual(['start rooms', 'start facts', 'dispose facts', 'dispose rooms']);
  });

  it('a module that throws while registering is skipped; its methods stay not_implemented', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerFactoryRpcModule('broken', () => {
      throw new Error('boom');
    });
    const router = new RpcRouter();
    const host = registerFactoryRpc(router, deps());
    expect(host.modules).toEqual([]);
    expect(await operatorCall(router, 'fact.poll')).toMatchObject({ result: { code: 'not_implemented' } });
    errSpy.mockRestore();
  });

  it('a module failing to start or dispose does not stop the others', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started: string[] = [];
    registerFactoryRpcModule('a', () => ({ start: () => { throw new Error('a'); } }));
    registerFactoryRpcModule('b', () => ({ start: () => { started.push('b'); } }));
    const host = registerFactoryRpc(new RpcRouter(), deps());
    await host.start();
    expect(started).toEqual(['b']);
    errSpy.mockRestore();
  });

  it('refuses a module name registered twice', () => {
    registerFactoryRpcModule('x', () => undefined);
    expect(() => registerFactoryRpcModule('x', () => undefined)).toThrow(/twice/);
  });

  it('runs the (empty) factory migrations on start without writing anything', async () => {
    const host = registerFactoryRpc(new RpcRouter(), deps());
    await host.start();
    expect(fs.existsSync(factoryMigrationMarkerPath(dir))).toBe(false);
  });
});
