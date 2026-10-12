// Agent factory — the bot role gate through the real dispatch pipeline. A bot
// token reaches exactly its role's surface: anything else is refused before
// enforcement in shadow AND enforce mode, and every refusal is reported to the
// onBotRefused listeners. A surface method goes on to normal enforcement
// (the bot lane), whatever clientName the bot's agent host reports. Commander
// tokens keep their existing behaviour.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../RpcRouter';
import { PluginTrustStore } from '../../mcp/PluginTrustStore';
import { registerMcpPluginRpc } from '../handlers/mcp.rpc';
import {
  botTokenBinding,
  commanderTokenWorkspace,
  mintBotToken,
  mintCommanderToken,
  resolveCommanderToken,
  revokeCommanderToken,
} from '../../deck/commanderTrust';
import type { RpcContext, RpcMethod } from '../../../shared/rpc';
import type { BotRefusal } from '../../../shared/botSurface';

let tmpDir = '';
let store: PluginTrustStore;
let router: RpcRouter;
let seen: { method: string; ctx?: RpcContext }[];

const HERMES = 'hermes-acp';
const VERIFIER = { workspaceId: 'ws-v', botId: 'bot-0000beef', role: 'verifier' as const };
const MOA = { workspaceId: 'ws-hq', botId: 'bot-0000cafe', role: 'moa' as const };

function wire(mode: 'shadow' | 'enforce'): void {
  registerMcpPluginRpc(router, store);
  for (const method of ['verify.recordVerdict', 'room.post', 'input.send', 'task.fanout.start', 'pane.list', 'pane.close', 'plan.propose'] as RpcMethod[]) {
    router.register(method, async (_params, ctx) => {
      seen.push({ method, ctx });
      return { ok: true };
    });
  }
  router.setTrustLookup(async (name) => store.get(name));
  router.setEnforcementMode(mode);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-gate-'));
  store = new PluginTrustStore(path.join(tmpDir, 'plugin-trust.json'));
  router = new RpcRouter();
  seen = [];
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function call(method: string, token: string, clientName = HERMES) {
  return router.dispatch(
    { id: `t-${method}`, method: method as RpcMethod, params: {}, clientName, commanderToken: token },
    { externalWire: true },
  );
}

describe('bot tokens (commanderTrust)', () => {
  it('resolves to the binding and to its workspace', () => {
    const token = mintBotToken(VERIFIER);
    try {
      expect(botTokenBinding(token)).toEqual(VERIFIER);
      expect(commanderTokenWorkspace(token)).toBe('ws-v');
      expect(resolveCommanderToken(token)).toEqual({ workspaceId: 'ws-v', bot: VERIFIER });
    } finally {
      revokeCommanderToken(token);
    }
    expect(botTokenBinding(token)).toBeNull();
  });

  it('refuses to mint for a malformed binding', () => {
    expect(() => mintBotToken({ workspaceId: '', botId: 'bot-0000beef', role: 'lead' })).toThrow();
    expect(() => mintBotToken({ workspaceId: 'ws', botId: 'x', role: 'lead' })).toThrow();
    expect(() => mintBotToken({ workspaceId: 'ws', botId: 'bot-0000beef', role: 'merge' as never })).toThrow();
  });

  it('a commander token has no bot binding', () => {
    const token = mintCommanderToken('ws-brain');
    try {
      expect(botTokenBinding(token)).toBeNull();
      expect(resolveCommanderToken(token)).toEqual({ workspaceId: 'ws-brain' });
    } finally {
      revokeCommanderToken(token);
    }
  });
});

describe.each(['shadow', 'enforce'] as const)('bot role gate (%s mode)', (mode) => {
  beforeEach(() => wire(mode));

  it('refuses an off-surface method before any handler runs, and reports it', async () => {
    const refusals: BotRefusal[] = [];
    const off = router.onBotRefused((r) => refusals.push(r));
    const token = mintBotToken(VERIFIER);
    try {
      for (const method of ['input.send', 'plan.propose', 'pane.list']) {
        const res = await call(method, token);
        expect(res.ok, method).toBe(false);
        if (!res.ok) expect(res.error).toContain('not on the verifier bot surface');
      }
      const teardown = await call('pane.close', token);
      expect(teardown.ok).toBe(false);
      if (!teardown.ok) expect(teardown.error).toContain('teardown');
      expect(seen).toEqual([]);
      expect(refusals.map((r) => [r.method, r.reason])).toEqual([
        ['input.send', 'surface'],
        ['plan.propose', 'surface'],
        ['pane.list', 'surface'],
        ['pane.close', 'teardown'],
      ]);
      expect(refusals[0].bot).toEqual(VERIFIER);
    } finally {
      off();
      revokeCommanderToken(token);
    }
  });

  it('lets a surface method through to the handler with ctx.bot set, for a non-first-party host', async () => {
    const token = mintBotToken(VERIFIER);
    try {
      const res = await call('verify.recordVerdict', token);
      expect(res.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].ctx?.bot).toEqual(VERIFIER);
      expect(seen[0].ctx?.commanderWorkspace).toBe('ws-v');
    } finally {
      revokeCommanderToken(token);
    }
  });

  it('confines each role to its own surface', async () => {
    const token = mintBotToken(MOA);
    try {
      expect((await call('plan.propose', token)).ok).toBe(true);
      expect((await call('task.fanout.start', token)).ok).toBe(false);
      expect((await call('verify.recordVerdict', token)).ok).toBe(false);
    } finally {
      revokeCommanderToken(token);
    }
  });

  it('a revoked bot token fails the whole request closed', async () => {
    const token = mintBotToken(VERIFIER);
    revokeCommanderToken(token);
    const res = await call('verify.recordVerdict', token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('invalid or revoked');
    expect(seen).toEqual([]);
  });

  it('a commander token is unaffected: no ctx.bot, its own lane, no bot refusal', async () => {
    const listener = vi.fn();
    router.onBotRefused(listener);
    const token = mintCommanderToken('ws-brain');
    try {
      const res = await call('pane.list', token);
      expect(res.ok).toBe(true);
      expect(seen[0].ctx?.bot).toBeUndefined();
      expect(seen[0].ctx?.commanderWorkspace).toBe('ws-brain');
      const teardown = await call('pane.close', token);
      expect(teardown.ok).toBe(false);
      if (!teardown.ok) expect(teardown.error).toContain('orchestrator brains (teardown gate)');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      revokeCommanderToken(token);
    }
  });
});

describe('bot role gate — a throwing refusal listener never changes the dispatch', () => {
  it('still refuses', async () => {
    wire('shadow');
    router.onBotRefused(() => {
      throw new Error('boom');
    });
    const token = mintBotToken(VERIFIER);
    try {
      const res = await call('input.send', token);
      expect(res.ok).toBe(false);
    } finally {
      revokeCommanderToken(token);
    }
  });
});
