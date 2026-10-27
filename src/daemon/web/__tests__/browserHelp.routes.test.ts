import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { BrowserHelpTable } from '../../phone/BrowserHelpTable';
import { HelpRequests } from '../../../main/browser-session/HelpRequests';
import { browserHelpRow, handlePhoneBrowserHelpCommand, type BrowserHelpTabDeps } from '../../../main/phone/PhoneBrowserHelp';

/**
 * Browser help requests on the phone contract, end to end: the real server,
 * the real desktop bridge and daemon table, and main's real store and decision
 * command behind them. Publishing the table stands in for main's feed.
 */

const PROMPT = 'Sign in to the shop, then press Done.';
const tabs: BrowserHelpTabDeps = {
  backend: () => 'builtin',
  builtinUrl: (surfaceId) => (surfaceId === 'surf-1' ? 'https://login.example.com/session' : null),
  isLiveChrome: () => false,
  chromeTabs: async () => [],
};

describe('browser help routes', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  async function start(opts: { allowTranscript?: boolean; allowInput?: boolean; announce?: string[]; publish?: boolean } = {}) {
    const store = new HelpRequests({ open: () => undefined, close: () => undefined });
    const commands: string[] = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      commands.push(data.command);
      queueMicrotask(async () => {
        const result = await handlePhoneBrowserHelpCommand(data.command, data.payload, () => store);
        bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
      });
      return true;
    }, 500);
    bridge.register('main', opts.announce ?? ['browser.help', 'workspaces.browserHelpDecide']);
    const table = new BrowserHelpTable({
      firstParty: (id) => id === 'main',
      isOwner: (id) => bridge.isOwner(id),
      emit: (frames) => server?.emitBrowserHelp(frames),
    });
    // Main's feed: the whole table on every change.
    const publish = async () => table.set('main', { requests: await Promise.all(store.listPending().map((r) => browserHelpRow(r, tabs))), closed: store.listSettled() });
    if (opts.publish !== false) {
      store.onChange(() => { void publish(); });
      await publish();
    }
    // d1: input granted explicitly; d2: paired before grants existed; d3: no
    // input grant (read-only); d4: revoked; d5: revoked while its body is read.
    const roster: Record<string, { allowInput: boolean; explicit: boolean }> = {
      d1: { allowInput: true, explicit: true },
      d2: { allowInput: true, explicit: false },
      d3: { allowInput: false, explicit: false },
      d5: { allowInput: true, explicit: true },
    };
    let d5Checks = 0;
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        if (deviceId === 'd4' || (deviceId === 'd5' && d5Checks++ > 0)) return { ok: false, reason: 'revoked' };
        const d = roster[deviceId];
        return d && secret === `s${deviceId.slice(1)}` ? { ok: true, deviceId, allowInput: d.allowInput } : { ok: false, reason: 'unknown' };
      },
      list: () => [{ deviceId: 'd1', name: 'd1', createdAt: 0, lastSeenAt: 0, allowInput: true }],
      hasExplicitInputGrant: (deviceId) => roster[deviceId]?.explicit === true,
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(),
      browserHelp: () => table,
    });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: opts.allowInput ?? true, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const get = async (route: string, auth = 'Bearer d1.s1') => {
      const res = await fetch(`${base}${route}`, { headers: { Authorization: auth } });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
    };
    const decide = async (id: string, body: unknown, auth = 'Bearer d1.s1') => {
      const res = await fetch(`${base}/api/browser-help/${id}/decision`, {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
    };
    const open = (surfaceId = 'surf-1') => store.create({ workspaceId: 'ws-1', surfaceId, prompt: PROMPT, timeoutMs: 60_000 });
    return { base, get, decide, open, store, table, commands, publish, operator: `Bearer ${info.token as string}` };
  }

  describe('/api/config', () => {
    it('announces browserHelp under the transcript consent to a desktop that published it', async () => {
      const r = await start();
      expect((await r.get('/api/config')).body.browserHelp).toBe(true);
      expect((await r.get('/api/config', 'Bearer d3.s3')).body.browserHelp).toBe(true);
    });

    it('omits it for an old desktop that announced nothing, and without the transcript consent', async () => {
      const old = await start({ announce: [] });
      expect((await old.get('/api/config')).body).not.toHaveProperty('browserHelp');
      await server!.stop();
      const off = await start({ allowTranscript: false });
      expect((await off.get('/api/config')).body).not.toHaveProperty('browserHelp');
    });
  });

  describe('GET /api/browser-help', () => {
    it('lists the open requests from the table for any paired device, with no desktop round trip', async () => {
      const r = await start();
      const info = r.open();
      await r.publish();
      for (const auth of [r.operator, 'Bearer d1.s1', 'Bearer d3.s3']) {
        expect(await r.get('/api/browser-help', auth)).toMatchObject({
          status: 200, cache: 'no-store',
          body: { requests: [{ requestId: info.requestId, workspaceId: 'ws-1', surfaceId: 'surf-1', prompt: PROMPT, backend: 'builtin', previewable: true, origin: 'https://login.example.com', deadlineAt: info.deadlineAt }] },
        });
      }
      expect(r.commands).toEqual([]);
      expect((await r.get('/api/browser-help', 'Bearer d4.s4')).status).toBe(401);
    });

    it('is 403 without the transcript consent and 503 before a desktop published a table', async () => {
      const off = await start({ allowTranscript: false });
      expect(await off.get('/api/browser-help')).toMatchObject({ status: 403, body: { error: 'browser-help-disabled' } });
      await server!.stop();
      const unpublished = await start({ publish: false });
      expect(await unpublished.get('/api/browser-help')).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
    });
  });

  describe('POST /api/browser-help/:requestId/decision', () => {
    it('settles the request in the workspace the table names; a second answer is 409', async () => {
      const r = await start();
      const info = r.open();
      await r.publish();
      expect(await r.decide(info.requestId, { outcome: 'continued' })).toMatchObject({ status: 200, cache: 'no-store', body: { requestId: info.requestId, state: 'continued' } });
      expect((await r.store.status(info.requestId, 'ws-1'))?.state).toBe('continued');
      // Main republished on the settle: the id is closed on the daemon now.
      await vi.waitFor(() => expect(r.table.lookup(info.requestId)).toEqual({ closed: true }), { timeout: 5_000 });
      expect(await r.decide(info.requestId, { outcome: 'cancelled' })).toMatchObject({ status: 409, body: { error: 'browser-help-closed' } });
      expect((await r.store.status(info.requestId, 'ws-1'))?.state).toBe('continued');
    });

    it('is 409 when main already settled it though the table still lists it', async () => {
      const r = await start({ publish: false });
      const info = r.open();
      await r.publish();
      // Answered at the desk; the daemon has not heard yet.
      await r.store.resolveFromRenderer(info.requestId, 'cancelled');
      expect(await r.decide(info.requestId, { outcome: 'continued' })).toMatchObject({ status: 409, body: { error: 'browser-help-closed' } });
      expect((await r.store.status(info.requestId, 'ws-1'))?.state).toBe('cancelled');
    });

    it('is 404 for an id the table does not hold, and 400 for any other body', async () => {
      const r = await start();
      const info = r.open();
      await r.publish();
      expect(await r.decide('req-unknown', { outcome: 'continued' })).toMatchObject({ status: 404, body: { error: 'browser-help-not-found' } });
      // The workspace never comes from the body.
      expect(await r.decide(info.requestId, { outcome: 'continued', workspaceId: 'ws-2' })).toMatchObject({ status: 400, body: { error: 'invalid-decision' } });
      expect(await r.decide(info.requestId, { outcome: 'completed' })).toMatchObject({ status: 400 });
      expect(await r.decide(info.requestId, {})).toMatchObject({ status: 400 });
      expect(r.commands).toEqual([]);
      expect((await r.store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
    });

    it('refuses a read-only device, a grant not set explicitly, a revoked device and one revoked mid-body', async () => {
      const r = await start();
      const info = r.open();
      await r.publish();
      expect(await r.decide(info.requestId, { outcome: 'continued' }, 'Bearer d3.s3')).toMatchObject({ status: 403, body: { error: 'read-only: this device was paired without permission to type' } });
      expect(await r.decide(info.requestId, { outcome: 'continued' }, 'Bearer d2.s2')).toMatchObject({ status: 403, body: { error: 'read-only: this device has no explicit input grant' } });
      expect(await r.decide(info.requestId, { outcome: 'continued' }, 'Bearer d4.s4')).toMatchObject({ status: 401, body: { reason: 'revoked' } });
      expect(await r.decide(info.requestId, { outcome: 'continued' }, 'Bearer d5.s5')).toMatchObject({ status: 401, body: { error: 'authorization-expired' } });
      expect(r.commands).toEqual([]);
      expect((await r.store.status(info.requestId, 'ws-1'))?.state).toBe('pending');
    });

    it('a read-only server or no transcript consent takes no decision from anyone', async () => {
      const ro = await start({ allowInput: false });
      const info = ro.open();
      await ro.publish();
      expect(await ro.decide(info.requestId, { outcome: 'continued' }, ro.operator)).toMatchObject({ status: 403, body: { error: 'read-only' } });
      await server!.stop();
      const off = await start({ allowTranscript: false });
      const other = off.open();
      await off.publish();
      expect(await off.decide(other.requestId, { outcome: 'continued' }, off.operator)).toMatchObject({ status: 403, body: { error: 'browser-help-disabled' } });
      expect((await off.store.status(other.requestId, 'ws-1'))?.state).toBe('pending');
    });
  });

  describe('SSE browser.help', () => {
    it('sends open and close frames live, with no prompt, and never records them in the backlog', async () => {
      const r = await start();
      const ac = new AbortController();
      const res = await fetch(`${r.base}/api/events`, { signal: ac.signal, headers: { Authorization: 'Bearer d3.s3', Accept: 'text/event-stream' } });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let wire = '';
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            wire += Buffer.from(chunk.value).toString('utf8');
          }
        } catch { /* aborted */ }
      })();
      const until = async (cond: () => boolean) => {
        const deadline = Date.now() + 4000;
        while (!cond()) {
          if (Date.now() > deadline) throw new Error('timed out');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      try {
        await until(() => wire.length > 0);
        const info = r.open();
        await until(() => wire.includes('"phase":"open"'));
        expect(await r.decide(info.requestId, { outcome: 'cancelled' })).toMatchObject({ status: 200 });
        await until(() => wire.includes('"phase":"close"'));
        const frames = wire.split('\n\n').filter((block) => block.includes('event: browser.help'));
        expect(frames).toHaveLength(2);
        for (const block of frames) expect(block).not.toMatch(/^id:/m);
        const data = frames.map((block) => JSON.parse(block.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
        expect(data).toEqual([
          { phase: 'open', requestId: info.requestId, workspaceId: 'ws-1', surfaceId: 'surf-1', deadlineAt: info.deadlineAt },
          { phase: 'close', requestId: info.requestId, workspaceId: 'ws-1', surfaceId: 'surf-1', deadlineAt: info.deadlineAt, state: 'cancelled' },
        ]);
        expect(wire).not.toContain('Sign in');
        expect(wire).not.toContain('login.example.com');
      } finally {
        ac.abort();
      }
      const backlog = await r.get('/api/events');
      expect(backlog.status).toBe(200);
      expect(JSON.stringify(backlog.body)).not.toContain('browser.help');
      expect(JSON.stringify(backlog.body)).not.toContain('Sign in');
    });
  });
});
