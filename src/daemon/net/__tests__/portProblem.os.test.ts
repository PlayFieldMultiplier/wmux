import { afterEach, describe, it, expect } from 'vitest';
import net from 'node:net';
import { diagnoseListenProblem, loopbackPortFree, type LookupExec } from '../portProblem';
import { disposeAll, makePc } from '../../a2aRemote/__tests__/a2aServerRig';

const NETSH = ['', 'Protocol tcp Port Exclusion Ranges', '', 'Start Port    End Port', '----------    --------', '     49181       49280', '     50000       50059     *', ''].join('\r\n');

function fakeExec(netstat: string, tasklist: string, calls: string[] = []): LookupExec {
  return async (file, args) => {
    calls.push(`${file.split('\\').pop()} ${args.join(' ')}`);
    if (/netsh/i.test(file)) return NETSH;
    if (/netstat/i.test(file)) return args.includes('TCPv6') ? '' : netstat;
    if (/tasklist/i.test(file)) return tasklist;
    throw new Error(`unexpected ${file}`);
  };
}

describe('diagnoseListenProblem (fake tools)', () => {
  it('Windows EACCES inside an excluded range: reserved, no holder lookup, a port past the range', async () => {
    const calls: string[] = [];
    const r = await diagnoseListenProblem({ code: 'EACCES', port: 50000, address: null }, { platform: 'win32', exec: fakeExec('', '', calls), isFree: async () => true });
    expect(r).toEqual({ problem: { kind: 'port-reserved', port: 50000 }, holder: null, suggestion: 50060 });
    expect(calls.some((c) => /netstat/i.test(c))).toBe(false);
  });

  it('EADDRINUSE names the holder from netstat + tasklist', async () => {
    const r = await diagnoseListenProblem(
      { code: 'EADDRINUSE', port: 7681, address: '127.0.0.1' },
      {
        platform: 'win32',
        exec: fakeExec('  TCP    127.0.0.1:7681    0.0.0.0:0    LISTENING    4242\r\n', '"node.exe","4242","Console","1","45,000 K"\r\n'),
        isFree: async (p) => p !== 7682,
        selfImage: 'wmux.exe',
      },
    );
    expect(r).toEqual({ problem: { kind: 'port-in-use', port: 7681 }, holder: { kind: 'process', pid: 4242, image: 'node.exe' }, suggestion: 7683 });
  });

  it('our own image is "another copy of wmux"; an unreadable image keeps only the PID', async () => {
    const netstat = '  TCP    0.0.0.0:45660    0.0.0.0:0    LISTENING    9\r\n';
    const wmux = await diagnoseListenProblem({ code: 'EADDRINUSE', port: 45660, address: null }, { platform: 'win32', exec: fakeExec(netstat, '"wmux.exe","9","Console","1","1 K"'), isFree: async () => true, selfImage: 'wmux.exe' });
    expect(wmux.holder).toEqual({ kind: 'wmux', pid: 9 });
    const garbled = await diagnoseListenProblem({ code: 'EADDRINUSE', port: 45660, address: null }, { platform: 'win32', exec: fakeExec(netstat, '"ÇÁ.exe","9","Console","1","1 K"'), isFree: async () => true, selfImage: 'wmux.exe' });
    expect(garbled.holder).toEqual({ kind: 'unnamed', pid: 9 });
  });

  it('an EACCES outside every range is a port in use', async () => {
    const r = await diagnoseListenProblem({ code: 'EACCES', port: 45660, address: null }, { platform: 'win32', exec: fakeExec('', ''), isFree: async () => true });
    expect(r.problem).toEqual({ kind: 'port-in-use', port: 45660 });
    expect(r.holder).toBeNull();
  });

  it('a gone address suggests no port', async () => {
    const r = await diagnoseListenProblem({ code: 'EADDRNOTAVAIL', port: 45651, address: '10.0.0.5' }, { platform: 'win32', exec: fakeExec('', ''), isFree: async () => true });
    expect(r).toEqual({ problem: { kind: 'address-gone', address: '10.0.0.5' }, holder: null, suggestion: null });
  });

  it('a failing tool leaves its part empty', async () => {
    const r = await diagnoseListenProblem({ code: 'EADDRINUSE', port: 45660, address: null }, { platform: 'win32', exec: async () => { throw new Error('timed out'); }, isFree: async () => true });
    expect(r).toEqual({ problem: { kind: 'port-in-use', port: 45660 }, holder: null, suggestion: 45661 });
  });
});

describe('a real port in use (loopback, owned by this test)', () => {
  const owned: net.Server[] = [];
  afterEach(async () => {
    await disposeAll();
    for (const s of owned.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  async function holdPort(): Promise<number> {
    const srv = net.createServer();
    owned.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return (srv.address() as net.AddressInfo).port;
  }

  it('A2A reports EADDRINUSE with the port it tried, and the holder is this test process', async () => {
    const port = await holdPort();
    const pc = await makePc('PC A', { port });
    expect(pc.server.status()).toMatchObject({ listening: false, lastError: 'EADDRINUSE', lastErrorCode: 'EADDRINUSE', lastErrorPort: port });
    expect(await loopbackPortFree(port)).toBe(false);
    const r = await diagnoseListenProblem({ code: 'EADDRINUSE', port, address: null }, { selfImage: 'wmux.exe' });
    expect(r.problem).toEqual({ kind: 'port-in-use', port });
    if (process.platform === 'win32') {
      expect(r.holder).toMatchObject({ pid: process.pid });
    }
    expect(r.suggestion === null || r.suggestion > port).toBe(true);
  }, 30_000);
});
