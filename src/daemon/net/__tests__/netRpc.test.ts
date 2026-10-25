// @wmux-lane unit — 'win32' here is the platform the probe is told it runs on; its PowerShell, interfaces and paths are all fakes.
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerNetRpc, type NetRpcDeps } from '../rpc';
import { FirewallRecordStore } from '../firewallRecord';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-netrpc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const EXE = 'C:\\w\\app-1.0.0\\wmux.exe';
type Handler = (params: Record<string, unknown>) => Promise<unknown>;

function setup(over: Partial<NetRpcDeps> = {}) {
  const handlers = new Map<string, Handler>();
  let probes = 0;
  const records = new FirewallRecordStore(dir);
  registerNetRpc((m, h) => handlers.set(m, h), {
    target: (listener) => ({ listener, applicable: true, port: 45660, ips: ['192.168.1.10'], inboundSeenAt: null, tailnet: false }),
    failure: () => null,
    records,
    scope: { dataSuffix: '', user: 'D\\u', group: 'wmux' },
    exe: EXE,
    platform: 'linux',
    now: () => 1,
    ...over,
  });
  const call = (m: string, p: Record<string, unknown>) => {
    if (m === 'net.inboundStatus') probes += 1;
    const h = handlers.get(m);
    if (!h) throw new Error(`no handler for ${m}`);
    return h(p);
  };
  return { handlers, call, records, probes: () => probes };
}

describe('net.* RPCs', () => {
  it('registers the four methods', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['net.firewallRecord', 'net.firewallTarget', 'net.inboundStatus', 'net.listenProblem']);
  });

  it('refuses an unknown listener', async () => {
    const { call } = setup();
    for (const m of ['net.inboundStatus', 'net.listenProblem', 'net.firewallTarget', 'net.firewallRecord']) {
      await expect(call(m, { listener: 'ssh' })).rejects.toThrow(/listener/);
    }
  });

  it('net.listenProblem is null when the listener did not fail to bind', async () => {
    expect(await setup().call('net.listenProblem', { listener: 'a2a' })).toBeNull();
  });

  it('net.firewallTarget reports this daemon\'s program, not the caller\'s', async () => {
    expect(await setup().call('net.firewallTarget', { listener: 'web', exe: 'C:\\evil.exe' })).toEqual({
      listener: 'web', platform: 'linux', exe: EXE, applicable: true, port: 45660, tailnet: false,
    });
  });

  it('net.firewallRecord set writes what the daemon serves; clear forgets it', async () => {
    const { call, records } = setup();
    expect(await call('net.firewallRecord', { listener: 'a2a', op: 'set', port: 1, exe: 'C:\\evil.exe' })).toEqual({ ok: true });
    expect(records.get('a2a')).toMatchObject({ port: 45660, exe: EXE, id: expect.stringMatching(/^wmux-a2a-[0-9a-f]{8}$/) });
    expect(await call('net.firewallRecord', { listener: 'a2a', op: 'clear' })).toEqual({ ok: true });
    expect(records.get('a2a')).toBeNull();
    await expect(call('net.firewallRecord', { listener: 'a2a', op: 'drop' })).rejects.toThrow(/op/);
  });

  it('net.firewallRecord set does nothing while the listener is down', async () => {
    const { call, records } = setup({ target: (listener) => ({ listener, applicable: false, port: null, ips: [], inboundSeenAt: null, tailnet: false }) });
    expect(await call('net.firewallRecord', { listener: 'a2a', op: 'set' })).toEqual({ ok: false });
    expect(records.get('a2a')).toBeNull();
  });

  it('net.inboundStatus answers (nothing to check on this OS)', async () => {
    expect(await setup().call('net.inboundStatus', { listener: 'a2a' })).toMatchObject({ listener: 'a2a', platform: 'other', applicable: false });
  });
});

describe('net.inboundStatus: who shares a probe', () => {
  const on = { en: 1, inb: 1, loc: 1 };
  const LINE = `${JSON.stringify({ v: 1, prof: { Domain: on, Private: on, Public: on }, addr: [{ ip: '192.168.1.10', cat: 1 }], rules: [], legacy: 0, tp: 0, tpName: null })}\r\n`;

  /** A Windows probe whose PowerShell answers only when the test says so. */
  function slowProbes(over: Partial<NetRpcDeps> = {}) {
    const pending: Array<() => void> = [];
    let n = 0;
    const s = setup({
      platform: 'win32',
      exe: EXE,
      probe: {
        exec: () => {
          n += 1;
          return new Promise<string>((resolve) => pending.push(() => resolve(LINE)));
        },
        ifaces: () => ({}),
        exists: () => true,
        onLocalFixedDrive: () => true,
        system32: () => 'C:\\Windows\\System32',
        log: () => undefined,
      },
      ...over,
    });
    const settle = async (i: number) => {
      pending[i]();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { ...s, spawned: () => n, settle };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('two asks for the same listener and facts share one PowerShell', async () => {
    const { call, spawned, settle } = slowProbes();
    const a = call('net.inboundStatus', { listener: 'a2a' });
    const b = call('net.inboundStatus', { listener: 'a2a' });
    await tick();
    expect(spawned()).toBe(1);
    await settle(0);
    expect(await a).toBe(await b);
  });

  it('fresh never joins a probe that started earlier; a later ask joins the fresh one', async () => {
    const { call, spawned, settle } = slowProbes();
    const before = call('net.inboundStatus', { listener: 'a2a' });
    await tick();
    const after = call('net.inboundStatus', { listener: 'a2a', fresh: true });
    await tick();
    expect(spawned()).toBe(2);
    // The first probe ends first; its cleanup must not drop the fresh one's slot.
    await settle(0);
    const third = call('net.inboundStatus', { listener: 'a2a' });
    await tick();
    expect(spawned()).toBe(2);
    await settle(1);
    expect(await third).toBe(await after);
    expect(await before).not.toBe(await after);
  });

  it('a probe started for another port never answers for the new one', async () => {
    let port = 45660;
    const { call, spawned, settle } = slowProbes({
      target: (listener) => ({ listener, applicable: true, port, ips: ['192.168.1.10'], inboundSeenAt: null, tailnet: false }),
    });
    const old = call('net.inboundStatus', { listener: 'a2a' });
    await tick();
    port = 45661;
    const moved = call('net.inboundStatus', { listener: 'a2a' });
    await tick();
    expect(spawned()).toBe(2);
    await settle(0);
    await settle(1);
    expect(((await old) as { port: number }).port).toBe(45660);
    expect(((await moved) as { port: number }).port).toBe(45661);
  });
});
