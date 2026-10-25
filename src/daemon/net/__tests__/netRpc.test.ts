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
