// A bot's picture stays out of the pipe and out of every bot's context:
// bot.create / bot.update refuse an `avatar`, bot.list / create / update
// answer profiles without one, and the prompts a bot is given never carry it.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('../../../deck/taskLedgerHost', () => ({ getTaskLedger: () => ({ onTransition: () => () => undefined, get: () => null, list: () => [] }) }));

import type { RpcContext } from '../../../../shared/rpc';
import { registerBotRpcHandlers } from '../bot.rpc';
import type { FactoryRouter } from '../../../factory/factoryHost';
import { BotStore, botsFilePath } from '../../../factory/botStore';
import type { BotRuntime } from '../../../factory/BotRuntime';
import { rolePrompt } from '../../../factory/roles';
import { buildWakePrompt, defaultBotSystemPrompt } from '../../../factory/wakePrompt';
import { pngDataUrl } from '../../../factory/__tests__/testPng';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
const MOA: RpcContext = { origin: 'local', commanderWorkspace: 'ws-hq', bot: { workspaceId: 'ws-hq', botId: 'bot-0000000a', role: 'moa' } };
const AVATAR = pngDataUrl(32, 32);

let dir = '';
let store: BotStore;
let call: (m: string, p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-botrpc-'));
  store = new BotStore(botsFilePath(dir));
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h), onBotRefused: () => () => undefined } as unknown as FactoryRouter;
  const runtime = { status: () => null, profileChanged: () => undefined } as unknown as BotRuntime;
  registerBotRpcHandlers(router, () => ({ store, runtime }));
  call = (m, p, ctx = OPERATOR) => (handlers.get(m) as Handler)(p, ctx);
});
afterEach(async () => {
  await store.flush().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the pipe never takes or returns a bot picture', () => {
  it('bot.create refuses an avatar and creates nothing', async () => {
    expect(await call('bot.create', { workspaceId: 'ws-1', role: 'triage', avatar: AVATAR })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list()).toEqual([]);
  });

  it('bot.update refuses an avatar and leaves the picture as it was', async () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage' });
    if (!bot.ok) throw new Error('create failed');
    expect(await call('bot.update', { botId: bot.bot.id, patch: { avatar: AVATAR } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await call('bot.update', { botId: bot.bot.id, patch: { name: 'Ada', avatar: AVATAR } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.get(bot.bot.id)?.avatar).toBeUndefined();
  });

  it('bot.list (operator and the HQ bot) and bot.update answer profiles without the picture', async () => {
    const bot = store.create({ workspaceId: 'ws-1', role: 'triage', avatar: AVATAR });
    if (!bot.ok) throw new Error('create failed');
    for (const ctx of [OPERATOR, MOA]) {
      const listed = await call('bot.list', {}, ctx);
      expect(listed).toMatchObject({ ok: true, bots: [{ bot: { id: bot.bot.id, name: 'Triage' } }] });
      expect(JSON.stringify(listed)).not.toContain('data:image');
    }
    const updated = await call('bot.update', { botId: bot.bot.id, patch: { name: 'Ada' } });
    expect(updated).toMatchObject({ ok: true, bot: { name: 'Ada' } });
    expect(JSON.stringify(updated)).not.toContain('data:image');
    // The picture itself is untouched in the store.
    expect(store.get(bot.bot.id)?.avatar).toBe(AVATAR);
  });

  it('bot.create answers the profile without a picture', async () => {
    const created = await call('bot.create', { workspaceId: 'ws-1', role: 'triage' });
    expect(created).toMatchObject({ ok: true });
    expect(created).not.toHaveProperty('bot.avatar');
  });
});

describe('a bot\'s prompts never carry its picture', () => {
  it('role prompt, fallback system prompt and wake prompt', () => {
    const r = store.create({ workspaceId: 'ws-1', role: 'verifier', avatar: AVATAR, repo: { repoKey: 'github.com/acme/app', repoPath: '/repo' } });
    if (!r.ok) throw new Error('create failed');
    const base64 = AVATAR.slice('data:image/png;base64,'.length);
    const wake = buildWakePrompt({
      item: { id: 'wake-1', botId: r.bot.id, workspaceId: 'ws-1', reason: { kind: 'manual', by: 'human' }, priority: 0, enqueuedAt: 1, attempts: 0, state: 'running' },
      profile: r.bot,
    });
    for (const text of [rolePrompt(r.bot), defaultBotSystemPrompt(r.bot), wake]) {
      expect(text).not.toContain('data:image');
      expect(text).not.toContain(base64.slice(0, 40));
    }
  });
});
