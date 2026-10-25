// Keep the computer awake while a paired phone is attached: the web server
// tells the registered desktop when a phone attaches or leaves, and
// `/api/config` carries the desktop's `keepAwake` only while one is attached
// and has reported it. A real DeviceStore in a temp dir; the desktop is a real
// DesktopPhoneBridge whose pipe is a spy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebTerminalServer } from '../WebTerminalServer';
import { DeviceStore } from '../DeviceStore';
import { PHONE_ATTACH_WINDOW_MS } from '../phonePresence';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { DeviceKind } from '../../../shared/web';
import { waitFor } from '../../../test-utils/waitFor';

describe('keep the computer awake while a phone is attached', () => {
  let dir: string;
  let clock: number;
  let store: DeviceStore;
  let send: ReturnType<typeof vi.fn<(clientId: string, event: unknown) => boolean>>;
  let bridge: DesktopPhoneBridge;
  let servers: WebTerminalServer[];

  const makeServer = (desktop: DesktopPhoneBridge | null): WebTerminalServer => {
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    const server = new WebTerminalServer({
      sessionManager,
      devices: store,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
      now: () => clock,
      ...(desktop ? { desktop: () => desktop } : {}),
    });
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-awake-'));
    clock = 1_700_000_000_000;
    store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ }, now: () => clock });
    send = vi.fn<(clientId: string, event: unknown) => boolean>(() => true);
    bridge = new DesktopPhoneBridge(send);
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) if (s.isRunning) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = (s: WebTerminalServer) =>
    s.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
  const base = (s: WebTerminalServer) => `http://127.0.0.1:${s.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const pair = async (kind: DeviceKind) => {
    const d = await store.mint({ name: kind, allowInput: true, kind });
    return { deviceId: d.deviceId, token: `${d.deviceId}.${d.deviceSecret}` };
  };
  const config = async (s: WebTerminalServer, h: Record<string, string>) =>
    (await (await fetch(`${base(s)}/api/config`, { headers: h })).json()) as Record<string, unknown>;
  const openEvents = async (s: WebTerminalServer, h: Record<string, string>) => {
    const ac = new AbortController();
    const res = await fetch(`${base(s)}/api/events`, { signal: ac.signal, headers: { ...h, Accept: 'text/event-stream' } });
    return { ac, res };
  };
  const presence = (): boolean[] =>
    send.mock.calls
      .map((c) => c[1] as { type: string; data: { attached: boolean } })
      .filter((e) => e.type === 'phone.presence')
      .map((e) => e.data.attached);

  it('a headless daemon (no desktop) leaves keepAwake out of /api/config', async () => {
    const server = makeServer(null);
    await start(server);
    const phone = await pair('phone');
    expect(await config(server, bearer(phone.token))).not.toHaveProperty('keepAwake');
    expect(await config(server, bearer(server.status().token as string))).not.toHaveProperty('keepAwake');
  });

  it('keepAwake appears once the desktop reported it, exactly as reported, and leaves with the desktop', async () => {
    const server = makeServer(bridge);
    await start(server);
    const phone = await pair('phone');
    bridge.register('main');
    expect(await config(server, bearer(phone.token))).not.toHaveProperty('keepAwake');
    bridge.setKeepAwake('main', { mode: 'working', active: true });
    expect((await config(server, bearer(phone.token))).keepAwake).toEqual({ mode: 'working', active: true });
    bridge.setKeepAwake('main', { mode: 'off', active: false });
    expect((await config(server, bearer(phone.token))).keepAwake).toEqual({ mode: 'off', active: false });
    bridge.disconnect('main');
    expect(await config(server, bearer(phone.token))).not.toHaveProperty('keepAwake');
  });

  it('a phone\'s stream attaches; after it closes, the request window still holds until it ends', async () => {
    const server = makeServer(bridge);
    bridge.register('main');
    await start(server);
    const phone = await pair('phone');
    const events = await openEvents(server, bearer(phone.token));
    expect(events.res.status).toBe(200);
    await waitFor(() => presence().length === 1);
    expect(presence()).toEqual([true]);
    expect(server.phoneAttached()).toBe(true);

    // Past the window since its last request: the close ends it.
    clock += PHONE_ATTACH_WINDOW_MS + 1;
    events.ac.abort();
    await waitFor(() => presence().length === 2);
    expect(presence()).toEqual([true, false]);
  });

  it('another computer\'s stream and requests do not count', async () => {
    const server = makeServer(bridge);
    bridge.register('main');
    await start(server);
    const computer = await pair('computer');
    const events = await openEvents(server, bearer(computer.token));
    expect(events.res.status).toBe(200);
    await config(server, bearer(computer.token));
    expect(server.phoneAttached()).toBe(false);
    expect(presence()).toEqual([]);
    events.ac.abort();
  });

  it('the operator\'s own stream does not count', async () => {
    const server = makeServer(bridge);
    bridge.register('main');
    await start(server);
    const events = await openEvents(server, bearer(server.status().token as string));
    expect(events.res.status).toBe(200);
    expect(server.phoneAttached()).toBe(false);
    events.ac.abort();
  });

  it('a revoke detaches the phone at once', async () => {
    const server = makeServer(bridge);
    bridge.register('main');
    await start(server);
    const phone = await pair('phone');
    const events = await openEvents(server, bearer(phone.token));
    await waitFor(() => presence().length === 1);
    expect(store.revoke(phone.deviceId).ok).toBe(true);
    server.disconnectDevice(phone.deviceId);
    expect(server.phoneAttached()).toBe(false);
    expect(presence()).toEqual([true, false]);
    events.ac.abort();
  });

  it('a request attaches, and stopping the server detaches', async () => {
    const server = makeServer(bridge);
    bridge.register('main');
    await start(server);
    const phone = await pair('phone');
    await config(server, bearer(phone.token));
    expect(server.phoneAttached()).toBe(true);
    await server.stop();
    expect(server.phoneAttached()).toBe(false);
    expect(presence()).toEqual([true, false]);
  });
});
