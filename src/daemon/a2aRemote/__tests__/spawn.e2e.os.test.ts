// In-process end to end for remote spawn requests: A asks B, B answers `ok`
// at once and decides afterwards, and B's spawn result travels back through
// B's own outbox. Run with A as the joiner and with A as the server, so the
// result is shown to arrive in both roles. Real listeners on loopback TLS.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { SPAWN_TARGETS_LINK_ID, type A2aSpawnResultV1, type A2aSpawnTargetsV1 } from '../../../shared/a2aSpawn';
import type { DaemonConfig } from '../../types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteController } from '../controller';
import { A2aRemoteDelivery } from '../delivery';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import { joinRemoteHost } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { PeerStore } from '../peerStore';
import { RemoteHostStore } from '../remoteHostStore';
import { createA2aRoutes } from '../routes';
import { A2aServer } from '../server';
import { A2aSpawnReceiver } from '../spawnReceiver';
import { SpawnPolicyStore } from '../spawnPolicyStore';
import { SpawnRequestStore } from '../spawnRequestStore';
import { freePort } from './a2aServerRig';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const FAST = { connectMs: 5_000, requestMs: 10_000 };
const TIMING = { backoffMinMs: 30, backoffMaxMs: 150, livenessMs: 10_000, connectMs: 5_000, requestMs: 10_000 };

interface Pc {
  name: string;
  dir: string;
  hostId: string;
  remoteHosts: RemoteHostStore;
  delivery: A2aRemoteDelivery;
  server: A2aServer;
  policy: SpawnPolicyStore;
  spawn: A2aSpawnReceiver;
  results: Array<{ from: string; result: A2aSpawnResultV1 }>;
  targets: Array<{ from: string; targets: A2aSpawnTargetsV1 }>;
  /** Release the agent check (it waits until then). */
  release: () => void;
  stop: () => Promise<void>;
}

const pcs: Pc[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const pc of pcs) pc.release();
  await Promise.all(pcs.splice(0).map((pc) => Promise.race([pc.stop(), new Promise<void>((r) => setTimeout(r, 15_000))])));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function makePc(name: string, opts: { holdAgentCheck?: boolean } = {}): Promise<Pc> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-e2e-')));
  dirs.push(dir);
  const a2aDir = path.join(dir, 'a2a');
  const port = await freePort();
  const quiet = (): void => undefined;
  const store = { dir: a2aDir, scheduleHarden: quiet };
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: name, daemonEpoch: 1 } });
  tasks.restoreFromLog();
  let delivery: A2aRemoteDelivery | null = null;
  const links = new LinkStore({ ...store, onTransition: (l) => delivery?.onLinkTransition(l) });
  const exposures = new ExposureStore(store);
  const panes = new ExposedPaneCache();
  const peers = new PeerStore(store);
  const remoteHosts = new RemoteHostStore({ dir: a2aDir });
  const policy = new SpawnPolicyStore({ ...store });
  const requests = new SpawnRequestStore(store);
  let release = (): void => undefined;
  const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  const results: Pc['results'] = [];
  const targets: Pc['targets'] = [];
  const spawn = new A2aSpawnReceiver({
    policy,
    requests,
    enqueue: (h, env) => void delivery!.outbox.enqueue(h, env),
    agentInstalled: () => (opts.holdAgentCheck ? held : Promise.resolve(true)),
    // Every spawn result in these tests answers a request this test made.
    isOutstanding: () => true,
    onResult: (from, result) => results.push({ from, result }),
    onTargets: (from, t) => targets.push({ from, targets: t }),
    log: quiet,
  });
  const routes = createA2aRoutes({ exposures, panes, links, broadcast: quiet, log: quiet });
  const config = { a2aRemote: { enabled: true, port } } as unknown as DaemonConfig;
  const server = new A2aServer({
    controller: new A2aRemoteController({ config, persist: quiet }),
    identityDir: a2aDir,
    peers,
    onPeerRevoked: (hostId) => delivery?.onPeerRevoked(hostId),
    routes,
    hostname: () => name,
    ipv4s: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    log: quiet,
  });
  await server.whenIdle();
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  const onRpc = (m: string, h: (p: Record<string, unknown>) => Promise<unknown>): void => void handlers.set(m, h);
  registerA2aLinkRpc(onRpc, {
    links, exposures, panes, remoteHosts, broadcast: quiet, log: quiet, timeouts: FAST,
    notifyLinkChange: (...args) => delivery?.notifyLinkChange(...args),
  });
  delivery = new A2aRemoteDelivery({
    dir: a2aDir,
    links,
    taskService: tasks,
    peers,
    remoteHosts,
    broadcast: quiet,
    refreshLink: (linkId) => handlers.get('a2a.remote.links.refresh')!({ linkId }),
    spawn,
    log: quiet,
    timing: TIMING,
    heartbeatMs: 200,
    syncMs: 50,
  });
  delivery.registerRoutes(routes);
  delivery.registerRpc(onRpc);
  delivery.start();
  const pc: Pc = {
    name,
    dir,
    hostId: server.ensureIdentity().hostId,
    remoteHosts,
    delivery,
    server,
    policy,
    spawn,
    results,
    targets,
    release: () => release(),
    stop: async () => {
      await delivery!.stop();
      server.dispose();
      await server.whenIdle();
      log.close();
    },
  };
  pcs.push(pc);
  return pc;
}

async function pair(joiner: Pc, server: Pc): Promise<void> {
  const res = await joinRemoteHost(server.server.beginPairing().invite, {
    self: () => joiner.server.ensureIdentity(),
    selfName: joiner.name,
    remoteHosts: joiner.remoteHosts,
    timeouts: FAST,
  });
  expect(res.ok).toBe(true);
  joiner.delivery.syncSessions();
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** B allows A, the claude agent, and one git repository as root `web`. */
async function allow(b: Pc, aHostId: string): Promise<void> {
  const repo = path.join(b.dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const set = await b.policy.set({
    v: 1, enabled: true, approval: 'ask', followUps: 'ask', permissionMode: 'auto',
    hosts: { [aHostId]: { allowed: true } }, roots: [{ id: 'web', label: 'Web', path: repo }], agents: ['claude'], rules: [], version: 0,
  });
  expect(set.ok).toBe(true);
}

function spawnEnvelope(): A2aRemoteEnvelope {
  const spawnId = `sp-${crypto.randomUUID()}`;
  const now = Date.now();
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId: spawnId,
    linkVersion: 0,
    messageId: 'req',
    kind: 'link',
    link: { state: 'spawn', version: 0 },
    spawn: {
      v: 1, spawnId, agent: 'claude', folder: { root: 'web' }, text: 'fix the build',
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString(), from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    },
    sentAt: new Date(now).toISOString(),
  };
}

describe('remote spawn requests, end to end', () => {
  for (const aJoins of [true, false]) {
    it(`the result reaches A when A is the ${aJoins ? 'joiner' : 'server'}`, async () => {
      const a = await makePc('PC-A');
      const b = await makePc('PC-B');
      if (aJoins) await pair(a, b);
      else await pair(b, a);
      await allow(b, a.hostId);
      const env = spawnEnvelope();
      a.delivery.outbox.enqueue(b.hostId, env);
      await until(() => a.results.length > 0);
      // Nothing starts a spawn in this build: every request that passes is refused as not supported yet.
      expect(a.results).toEqual([{ from: b.hostId, result: { v: 1, spawnId: env.linkId, code: 'not-supported' } }]);
    });
  }

  it('a decision that is still running holds up nothing else between the two PCs', async () => {
    const a = await makePc('PC-A');
    const b = await makePc('PC-B', { holdAgentCheck: true });
    await pair(a, b);
    await allow(b, a.hostId);
    const env = spawnEnvelope();
    a.delivery.outbox.enqueue(b.hostId, env);
    // The next envelope from A gets through while B's decision waits.
    a.delivery.outbox.enqueue(b.hostId, {
      protocol: A2A_REMOTE_PROTOCOL, linkId: SPAWN_TARGETS_LINK_ID, linkVersion: 0, messageId: 'st-1', kind: 'link',
      link: { state: 'spawn-targets', version: 0 }, spawnTargets: { v: 1, version: 1, roots: [], agents: [] }, sentAt: new Date().toISOString(),
    });
    await until(() => b.targets.length > 0);
    expect(a.results).toEqual([]);
    b.release();
    await until(() => a.results.length > 0);
    expect(a.results[0].result).toMatchObject({ spawnId: env.linkId, code: 'not-supported' });
  });

  it('a PC that is not allowed is told so, and nothing is kept for it', async () => {
    const a = await makePc('PC-A');
    const b = await makePc('PC-B');
    await pair(a, b);
    const env = spawnEnvelope();
    a.delivery.outbox.enqueue(b.hostId, env);
    await until(() => a.results.length > 0);
    expect(a.results[0].result).toEqual({ v: 1, spawnId: env.linkId, code: 'not-allowed' });
    expect(fs.existsSync(path.join(b.dir, 'a2a', 'spawn-requests.json'))).toBe(false);
  });
});
