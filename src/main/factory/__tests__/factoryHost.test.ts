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
import { FACTORY_MIGRATION_STEPS, factoryMigrationMarkerPath } from '../migrate';

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

  it('a module that registers and then throws leaves nothing behind', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const heard = vi.fn();
    registerFactoryRpcModule('half', (router) => {
      router.register('room.post', async () => ({ ok: true }));
      router.onBotRefused(heard);
      throw new Error('late');
    });
    const router = new RpcRouter();
    registerFactoryRpc(router, deps());
    expect(await operatorCall(router, 'room.post')).toMatchObject({ result: { code: 'not_implemented' } });
    errSpy.mockRestore();
  });

  it('a committed module\'s refusal listener is subscribed, and its unsubscribe works', () => {
    let off: (() => void) | undefined;
    registerFactoryRpcModule('facts', (router) => {
      off = router.onBotRefused(() => undefined);
    });
    const router = new RpcRouter();
    const spy = vi.spyOn(router, 'onBotRefused');
    registerFactoryRpc(router, deps());
    expect(spy).toHaveBeenCalledTimes(1);
    off?.();
  });

  it('dispose during start stops further starts and disposes after the in-flight one', async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    registerFactoryRpcModule('slow', () => ({
      start: () => new Promise<void>((resolve) => { calls.push('start slow'); release = resolve; }),
      dispose: () => { calls.push('dispose slow'); },
    }));
    registerFactoryRpcModule('next', () => ({
      start: () => { calls.push('start next'); },
      dispose: () => { calls.push('dispose next'); },
    }));
    const host = registerFactoryRpc(new RpcRouter(), deps());
    const starting = host.start();
    await Promise.resolve();
    const disposing = host.dispose();
    release();
    await starting;
    await disposing;
    await host.start();
    expect(calls).toEqual(['start slow', 'dispose next', 'dispose slow']);
  });

  it('quit stops every module before any dispose, so a dispose that never ends cannot keep a module running', async () => {
    const calls: string[] = [];
    registerFactoryRpcModule('bots', () => ({
      stop: () => { calls.push('stop bots'); },
      dispose: () => { calls.push('dispose bots'); },
    }));
    registerFactoryRpcModule('lane', () => ({
      stop: () => { throw new Error('boom'); },
      dispose: () => new Promise<void>(() => { calls.push('dispose lane (never ends)'); }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = registerFactoryRpc(new RpcRouter(), deps());
    await host.start();
    void host.dispose();
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['stop bots', 'dispose lane (never ends)']);
  });

  it('starts no module when the migrations fail', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factoryMigrationMarkerPath(dir), JSON.stringify({ version: 'x' }));
    const started = vi.fn();
    registerFactoryRpcModule('a', () => ({ start: started }));
    await registerFactoryRpc(new RpcRouter(), deps()).start();
    expect(started).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('refuses a module name registered twice', () => {
    registerFactoryRpcModule('x', () => undefined);
    expect(() => registerFactoryRpcModule('x', () => undefined)).toThrow(/twice/);
  });

  it('runs the factory migrations on start and records the version reached', async () => {
    const host = registerFactoryRpc(new RpcRouter(), deps());
    await host.start();
    expect(JSON.parse(fs.readFileSync(factoryMigrationMarkerPath(dir), 'utf8')).version).toBe(FACTORY_MIGRATION_STEPS.length);
  });
});
