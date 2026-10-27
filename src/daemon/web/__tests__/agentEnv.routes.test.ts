import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { AGENT_ENV_COMMAND, AGENT_ENV_ROUTE } from '../../../shared/agentEnvSummary';

/** GET /api/agent-env: device-authenticated, answered by the desktop, bounded on the way out. */

const SHA = 'a'.repeat(64);

describe('agent env route', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  async function start(opts: { announce?: string[]; reply?: unknown } = {}) {
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string } }).data;
      queueMicrotask(() => {
        bridge.complete(clientId, { requestId: data.requestId, ok: data.command === AGENT_ENV_COMMAND, result: opts.reply });
      });
      return true;
    }, 500);
    bridge.register('main', opts.announce ?? [AGENT_ENV_COMMAND]);
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return deviceId === 'd1' && secret === 's1' ? { ok: true, deviceId, allowInput: false } : { ok: false, reason: 'unknown' };
      },
      list: () => [{ deviceId: 'd1', name: 'd1', createdAt: 0, lastSeenAt: 0, allowInput: false }],
      hasExplicitInputGrant: () => false,
    };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir() });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: false });
    const base = `http://127.0.0.1:${server.status().port}`;
    return async (auth?: string) => {
      const res = await fetch(`${base}${AGENT_ENV_ROUTE}`, auth ? { headers: { Authorization: auth } } : {});
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
  }

  it('refuses a caller without a credential, and answers a read-only paired device', async () => {
    const get = await start({
      reply: {
        schema: 1,
        wmuxVersion: '4.4.0',
        agents: [{ agent: 'claude', version: '2.1.0', executable: '/Users/someone/.local/bin/claude' }],
        skills: [{ agent: 'claude', name: 'review', source: 'user', originPath: '/Users/someone/.claude/skills/review' }],
        mcpServers: [],
        instructions: [{ file: '~/.claude/CLAUDE.md', sha256: SHA }, { file: '/etc/passwd', sha256: SHA }],
      },
    });
    expect((await get()).status).toBe(401);
    const res = await get('Bearer d1.s1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schema: 1,
      wmuxVersion: '4.4.0',
      agents: [{ agent: 'claude', version: '2.1.0' }],
      skills: [{ agent: 'claude', name: 'review', source: 'user' }],
      mcpServers: [],
      instructions: [{ file: '~/.claude/CLAUDE.md', sha256: SHA }],
    });
    expect(JSON.stringify(res.body)).not.toContain('/Users/');
  });

  it('says the desktop is unavailable when it does not answer the command', async () => {
    const get = await start({ announce: [] });
    expect(await get('Bearer d1.s1')).toEqual({ status: 503, body: { error: 'desktop-unavailable' } });
  });
});
