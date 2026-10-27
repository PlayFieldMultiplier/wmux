import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebTerminalStartOptions } from '../WebTerminalServer';
import { parseTrustedProxyConfig } from '../trustedProxy';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

describe('trusted proxy sign-in', () => {
  let server: WebTerminalServer;
  let logs: string[];

  const trustedProxy = parseTrustedProxyConfig(
    { header: 'X-Auth-Request-Email', user: 'me@example.com', from: ['127.0.0.1'] },
    { localPeerForTests: true },
  );

  const start = async (over: Partial<WebTerminalStartOptions> = {}) => {
    logs = [];
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      log: (_level, msg) => { logs.push(msg); },
      assetsDir: os.tmpdir(),
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, ...over });
  };

  afterEach(async () => {
    if (server?.isRunning) await server.stop();
  });

  const get = (path: string, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpReq(
        { host: '127.0.0.1', port: server.status().port, path, method: 'GET', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });

  const signedIn = { 'X-Auth-Request-Email': 'me@example.com' };

  it('lets the proxy-signed-in operator in without a token', async () => {
    await start({ trustedProxy });
    expect(await get('/api/config', signedIn)).toBe(200);
    expect(await get('/api/sessions', signedIn)).toBe(200);
    expect(logs.filter((l) => l.includes('trusted proxy: first request as me@example.com'))).toHaveLength(1);
  });

  it('judges a presented credential by itself, never by the proxy header', async () => {
    await start({ trustedProxy });
    expect(await get('/api/sessions', { ...signedIn, Authorization: 'Basic eDp5' })).toBe(401);
    expect(await get('/api/sessions', { ...signedIn, Authorization: 'Bearer not-the-token' })).toBe(401);
    expect(await get('/api/sessions?token=', signedIn)).toBe(401);
    expect(await get('/api/sessions', { Authorization: `Bearer ${server.status().token}` })).toBe(200);
  });

  it('refuses another user and counts it in status', async () => {
    await start({ trustedProxy });
    expect(await get('/api/sessions', { 'X-Auth-Request-Email': 'other@example.com' })).toBe(401);
    expect(server.status().trustedProxy).toEqual({
      header: 'x-auth-request-email',
      user: 'me@example.com',
      from: ['127.0.0.1'],
      refusals: { 'identity-mismatch': 1 },
    });
  });

  it('ignores the header when the server runs without trusted proxy sign-in', async () => {
    await start();
    expect(await get('/api/config', signedIn)).toBe(401);
    expect(await get('/api/sessions', signedIn)).toBe(401);
    expect(server.status().trustedProxy).toBeUndefined();
  });
});
