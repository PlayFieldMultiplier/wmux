// The listen gate: LanLink opens its listener only when the selected NIC's
// network reads as Private or Domain (or on an OS with no network category),
// says why when it does not, re-reads the category every 60 s while listening
// and on a backoff while refused, and never reads it on the 10 s liveness tick.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type os from 'node:os';
import { LanLinkServer } from '../server';
import { LANLINK_CONFIG_CHANGED } from '../controller';
import type { NetCategoryResult } from '../netCategory';

const NIC = { name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff' };

let currentIp: string | null;
const ifaces = () =>
  ({
    eth0: currentIp
      ? [
          {
            address: currentIp,
            family: 'IPv4',
            internal: false,
            mac: NIC.mac,
            netmask: '255.255.255.0',
            cidr: `${currentIp}/24`,
          },
        ]
      : [],
  }) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function controller(enabled: boolean) {
  return Object.assign(new EventEmitter(), {
    getStatus: () => ({ enabled, nic: NIC, port: null, effectivePort: 45651, nics: [] }),
  });
}

/**
 * What each listen() does: 'listen' emits `listening`, an Error emits `error`,
 * 'hold' does nothing until the test calls `release()`.
 */
type ListenOutcome = 'listen' | Error | 'hold';

interface FakeNet {
  listens: Array<{ port: number; ip: string }>;
  closes: number;
  outcomes: ListenOutcome[];
  servers: EventEmitter[];
  /** Emit `listening` on the last held server. */
  release: () => void;
  /** Hold every close callback until `releaseClose()`. */
  holdClose: boolean;
  releaseClose: () => void;
}

function makeServer(
  netCategory: (ip: string) => Promise<NetCategoryResult>,
  opts: { enabled?: boolean; outcomes?: ListenOutcome[] } = {},
) {
  const heldCloses: Array<() => void> = [];
  const net: FakeNet = {
    listens: [],
    closes: 0,
    outcomes: opts.outcomes ?? [],
    servers: [],
    release: () => net.servers[net.servers.length - 1].emit('listening'),
    holdClose: false,
    releaseClose: () => {
      for (const cb of heldCloses.splice(0)) cb();
    },
  };
  const ctl = controller(opts.enabled ?? true);
  const onStatusChange = vi.fn();
  const server = new LanLinkServer({
    inbox: {} as never,
    controller: ctl as never,
    nudge: () => undefined,
    peers: { dispose: () => undefined } as never,
    selfName: 'host',
    ifaces,
    netCategory,
    onStatusChange,
    createServer: () => {
      const s = Object.assign(new EventEmitter(), {
        maxConnections: 0,
        listen(port: number, ip: string) {
          net.listens.push({ port, ip });
          const outcome = net.outcomes.shift() ?? 'listen';
          if (outcome === 'hold') return;
          queueMicrotask(() => (outcome === 'listen' ? s.emit('listening') : s.emit('error', outcome)));
        },
        close(cb?: () => void) {
          net.closes += 1;
          if (net.holdClose) heldCloses.push(() => cb?.());
          else cb?.();
        },
      });
      net.servers.push(s);
      return s as never;
    },
  });
  return { server, net, ctl, onStatusChange };
}

/** A category read that stays pending until the test answers it. */
function pendingRead() {
  let answer: (c: NetCategoryResult) => void = () => undefined;
  const pending = new Promise<NetCategoryResult>((r) => {
    answer = r;
  });
  return { fn: vi.fn(() => pending), answer: (c: NetCategoryResult) => answer(c) };
}

/** Let queued promise callbacks run (fake timers do not advance). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A category source the test can change between reads. */
function categorySource(initial: NetCategoryResult | Error) {
  let next: NetCategoryResult | Error = initial;
  const fn = vi.fn(async () => {
    if (next instanceof Error) throw next;
    return next;
  });
  return { fn, set: (c: NetCategoryResult | Error) => { next = c; } };
}

async function advance(server: LanLinkServer, ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await server.settled();
}

beforeEach(() => {
  currentIp = '192.168.1.10';
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LanLinkServer network gate', () => {
  it('listens on a Private network', async () => {
    const { server, net } = makeServer(async () => 'Private');
    await server.settled();
    expect(net.listens).toEqual([{ port: 45651, ip: '192.168.1.10' }]);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it.each(['Domain', 'not-applicable'] as const)('listens on a %s network', async (category) => {
    const { server, net } = makeServer(async () => category);
    await server.settled();
    expect(net.listens).toEqual([{ port: 45651, ip: '192.168.1.10' }]);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it.each([
    ['Public', 'network-public'],
    ['Unknown', 'network-unknown'],
  ] as const)('does not listen on a %s network, and says why', async (category, reason) => {
    const { server, net } = makeServer(async () => category);
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: reason, checking: false });
    server.dispose();
  });

  it('does not listen when the category cannot be read', async () => {
    const { server, net } = makeServer(async () => {
      throw new Error('powershell.exe blocked');
    });
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-check-failed', checking: false });
    server.dispose();
  });

  it('does not read the category for a NIC with no address', async () => {
    currentIp = null;
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(netCategory).not.toHaveBeenCalled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'no-address', checking: false });
    server.dispose();
  });

  it('reports nothing while LanLink is off, and reads nothing', async () => {
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server, net } = makeServer(netCategory, { enabled: false });
    await server.settled();
    expect(netCategory).not.toHaveBeenCalled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null, checking: false });
    server.dispose();
  });
});

describe('LanLinkServer listen state', () => {
  it('reports listening only once the socket is listening, and checking until then', async () => {
    const { server, net } = makeServer(async () => 'Private', { outcomes: ['hold'] });
    await flush();
    expect(net.listens).toHaveLength(1);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null, checking: true });
    net.release();
    await server.settled();
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it('says checking while the category is being read', async () => {
    const read = pendingRead();
    const { server } = makeServer(read.fn);
    await flush();
    expect(read.fn).toHaveBeenCalled();
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null, checking: true });
    read.answer('Public');
    await server.settled();
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-public', checking: false });
    server.dispose();
  });

  it('reports listen-failed, not listening, when the port cannot be opened, then retries', async () => {
    const cat = categorySource('Private');
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const { server, net } = makeServer(cat.fn, { outcomes: [busy] });
    await server.settled();
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'listen-failed', listenErrorCode: 'EADDRINUSE', checking: false });
    expect(server.lastBindAttempt().port).toBe(45651);
    expect(server.isListening()).toBe(false);

    await advance(server, 5_000);
    expect(cat.fn).toHaveBeenCalledTimes(2); // a fresh read before the second bind
    expect(net.listens).toHaveLength(2);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it('closes and says listen-failed when an open listener fails later', async () => {
    const { server, net, onStatusChange } = makeServer(async () => 'Private');
    await server.settled();
    onStatusChange.mockClear();
    net.servers[0].emit('error', new Error('socket gone'));
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'listen-failed', listenErrorCode: null, checking: false });
    expect(onStatusChange).toHaveBeenCalled();
    server.dispose();
  });

  it('tells the daemon each time a reconcile finishes', async () => {
    const { server, onStatusChange } = makeServer(async () => 'Public');
    await server.settled();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    server.dispose();
  });

  it('settled() also waits for a pass queued by the one it waited for', async () => {
    const read = pendingRead();
    const { server, net } = makeServer(read.fn);
    await flush();
    currentIp = '192.168.1.20'; // the address moves while the category is read
    read.answer('Private');
    await server.settled();
    expect(net.listens).toEqual([{ port: 45651, ip: '192.168.1.20' }]);
    expect(server.runtimeStatus().checking).toBe(false);
    server.dispose();
  });
});

describe('LanLinkServer category re-reads', () => {
  it('does not read the category on the 10 s liveness tick', async () => {
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server } = makeServer(netCategory);
    await server.settled();
    for (let i = 0; i < 5; i++) await advance(server, 10_000);
    expect(netCategory).toHaveBeenCalledTimes(1);
    expect(server.isListening()).toBe(true);
    server.dispose();
  });

  it('re-reads every 60 s while listening, and closes when the same address turns Public', async () => {
    const cat = categorySource('Private');
    const { server, net, onStatusChange } = makeServer(cat.fn);
    await server.settled();

    await advance(server, 60_000);
    expect(cat.fn).toHaveBeenCalledTimes(2);
    expect(server.isListening()).toBe(true);

    cat.set('Public');
    onStatusChange.mockClear();
    await advance(server, 60_000);
    expect(cat.fn).toHaveBeenCalledTimes(3);
    expect(cat.fn).toHaveBeenLastCalledWith('192.168.1.10');
    expect(net.closes).toBe(1);
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-public', checking: false });
    expect(onStatusChange).toHaveBeenCalled();
    server.dispose();
  });

  it('never overlaps two re-reads', async () => {
    let call = 0;
    const read = pendingRead();
    const fn = vi.fn((): Promise<NetCategoryResult> => (++call === 1 ? Promise.resolve('Private') : read.fn()));
    const { server } = makeServer(fn);
    await server.settled();

    vi.advanceTimersByTime(60_000); // the re-read starts and stays pending
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(180_000);
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);

    read.answer('Private');
    await server.settled();
    await advance(server, 60_000);
    expect(fn).toHaveBeenCalledTimes(3);
    server.dispose();
  });

  it('retries a refused network after 5 s, 15 s, then every 60 s, and opens once it reads Private', async () => {
    const cat = categorySource('Public');
    const { server, net } = makeServer(cat.fn);
    await server.settled();
    expect(cat.fn).toHaveBeenCalledTimes(1);

    await advance(server, 5_000);
    expect(cat.fn).toHaveBeenCalledTimes(2);
    await advance(server, 14_999);
    expect(cat.fn).toHaveBeenCalledTimes(2);
    await advance(server, 1);
    expect(cat.fn).toHaveBeenCalledTimes(3);
    await advance(server, 60_000);
    expect(cat.fn).toHaveBeenCalledTimes(4);
    await advance(server, 60_000);
    expect(cat.fn).toHaveBeenCalledTimes(5);
    expect(net.listens).toEqual([]);

    cat.set('Private');
    await advance(server, 60_000);
    expect(net.listens).toEqual([{ port: 45651, ip: '192.168.1.10' }]);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it.each([
    ['a failed read', new Error('timed out')],
    ['a network still being classified', 'Unknown' as const],
  ])('opens after %s once a retry reads Private', async (_label, first) => {
    const cat = categorySource(first);
    const { server } = makeServer(cat.fn);
    await server.settled();
    expect(server.isListening()).toBe(false);
    cat.set('Private');
    await advance(server, 5_000);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });

  it('stops listening when the NIC moves from a Private to a Public network', async () => {
    const netCategory = vi.fn(async (ip: string) => (ip === '192.168.1.10' ? 'Private' : 'Public') as NetCategoryResult);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(server.isListening()).toBe(true);

    currentIp = '10.0.0.7';
    await advance(server, 10_000);

    expect(netCategory).toHaveBeenLastCalledWith('10.0.0.7');
    expect(net.closes).toBe(1);
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-public', checking: false });
    server.dispose();
  });

  it('starts listening when a refused NIC moves to a Private network', async () => {
    const netCategory = vi.fn(async (ip: string) => (ip === '10.0.0.7' ? 'Private' : 'Public') as NetCategoryResult);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(server.runtimeStatus().stopReason).toBe('network-public');

    currentIp = '10.0.0.7';
    await advance(server, 10_000);

    expect(net.listens.length).toBeGreaterThan(0);
    expect(net.listens.every((l) => l.ip === '10.0.0.7')).toBe(true);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null, checking: false });
    server.dispose();
  });
});

describe('LanLinkServer passes overtaken by a change', () => {
  it('opens no listener when LanLink is turned off while the category is being read', async () => {
    const read = pendingRead();
    const { server, net, ctl } = makeServer(read.fn);
    await flush();
    expect(read.fn).toHaveBeenCalled();
    ctl.emit(LANLINK_CONFIG_CHANGED, { enabled: false, nic: NIC });
    read.answer('Private');
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null, checking: false });
    server.dispose();
  });

  it('a config change with the same values still overtakes a pending read (a fresh status object each time)', async () => {
    const read = pendingRead();
    const { server, net, ctl } = makeServer(read.fn);
    await flush();
    ctl.emit(LANLINK_CONFIG_CHANGED, { enabled: true, nic: { ...NIC } });
    read.answer('Private');
    await server.settled();
    expect(read.fn).toHaveBeenCalledTimes(2); // the overtaken pass did not bind; the new one read again
    expect(net.listens).toHaveLength(1);
    expect(server.isListening()).toBe(true);
    server.dispose();
  });

  it('opens no listener and leaves no timer when disposed while the category is being read', async () => {
    const read = pendingRead();
    const { server, net } = makeServer(read.fn);
    await flush();
    expect(read.fn).toHaveBeenCalled();
    server.dispose();
    read.answer('Private');
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null, checking: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer when disposed while a failed bind is being closed', async () => {
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const { server, net } = makeServer(async () => 'Private', { outcomes: [busy] });
    net.holdClose = true;
    await flush();
    expect(net.closes).toBe(1); // the failed bind is closing
    server.dispose();
    net.releaseClose();
    await server.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(server.isListening()).toBe(false);
  });

  it('leaves no timer when disposed while a reconcile is closing the old listener', async () => {
    const { server, net, ctl } = makeServer(async () => 'Private');
    await server.settled();
    net.holdClose = true;
    ctl.emit(LANLINK_CONFIG_CHANGED, { enabled: true, nic: NIC, port: 45700 });
    await flush();
    expect(net.closes).toBe(1); // the pass is waiting for the old listener to close
    server.dispose();
    net.releaseClose();
    await server.settled();
    expect(vi.getTimerCount()).toBe(0);
    expect(net.listens).toHaveLength(1);
  });

  it('leaves no timer after dispose while listening', async () => {
    const { server } = makeServer(async () => 'Private');
    await server.settled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    server.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
