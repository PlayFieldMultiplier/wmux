// The first run's bot (handoff #3): made only after the plan consent, once
// (a second call, a re-run first run or a restart finds the same bot), with
// no worker slots, a read-only job and no greeting turn; a folder a bot
// cannot read is refused as "Add bot" refuses it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { BotStore, botsFilePath } from '../../factory/botStore';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../../factory/factorySettings';
import { BOTS_PLAN_CONSENT_VERSION } from '../../../shared/factorySettings';
import { FIRST_RUN_BOT_WORKERS } from '../../../shared/firstRun';
import { FIRST_RUN_BOT_JOB, checkFirstRunFolder, firstRunBot } from '../firstBot';
import { firstBotHandler } from '../index';
import type { GitResult } from '../../git/git';

let dir = '';
let store: BotStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-firstbot-'));
  store = new BotStore(botsFilePath(dir));
});
afterEach(async () => {
  await store.flush().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const ok = (stdout: string): GitResult => ({ stdout, stderr: '', code: 0 });
const fail: GitResult = { stdout: '', stderr: 'fatal', code: 128 };

/** A checkout at /src/app whose origin is github.com/example/app. */
function repoGit() {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return ok('/src/app\n');
    if (args.includes('config')) return ok('local\0remote.origin.url\nhttps://github.com/example/app.git\0');
    return ok('https://github.com/example/app.git\n');
  });
}
const deps = () => ({ git: repoGit(), realpath: (p: string) => p, homeDir: '/home/me' });

function consented(over: Partial<FactorySettings> = {}): FactorySettings {
  return { ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1] }, enabled: true, planConsent: { version: BOTS_PLAN_CONSENT_VERSION, at: '2026-10-23T00:00:00.000Z' }, ...over };
}

const req = { workspaceId: 'ws-1', folder: '/src/app' };

describe('the first run\'s bot', () => {
  it('is not made before the plan consent is stored and the bots are on', async () => {
    for (const settings of [null, consented({ planConsent: undefined }), consented({ enabled: false })]) {
      const r = await firstRunBot(store, settings, req, deps());
      expect(r).toMatchObject({ ok: false, code: 'consent_required' });
    }
    expect(store.list()).toHaveLength(0);
  });

  it('is made once: concurrent calls, a later call and a restart all get the same bot', async () => {
    const [a, b] = await Promise.all([firstRunBot(store, consented(), req, deps()), firstRunBot(store, consented(), req, deps())]);
    expect(store.list()).toHaveLength(1);
    if (!a.ok || !b.ok) throw new Error('expected both to answer a bot');
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(b.bot.id).toBe(a.bot.id);
    expect(a.threadId).toBe(`dm:${a.bot.id}`);
    // Another folder later still answers the first one's bot.
    const later = await firstRunBot(store, consented(), { workspaceId: 'ws-2', folder: '/elsewhere' }, deps());
    expect(later).toMatchObject({ ok: true, created: false, bot: { id: a.bot.id } });
    // A restart reads the mark back from bots.json.
    await store.flush();
    const reloaded = new BotStore(botsFilePath(dir));
    reloaded.load();
    const again = await firstRunBot(reloaded, consented(), req, deps());
    expect(again).toMatchObject({ ok: true, created: false, bot: { id: a.bot.id } });
    expect(reloaded.list()).toHaveLength(1);
  });

  it('has no worker slots, a read-only job and its folder\'s repository', async () => {
    const r = await firstRunBot(store, consented(), req, deps());
    if (!r.ok) throw new Error(r.message);
    const bot = store.get(r.bot.id);
    expect(bot?.budget.maxConcurrentWorkers).toBe(FIRST_RUN_BOT_WORKERS);
    expect(FIRST_RUN_BOT_WORKERS).toBe(0);
    expect(bot?.job).toBe(FIRST_RUN_BOT_JOB);
    expect(bot?.job).toMatch(/Do not change files, start workers, push, or open a pull request/);
    expect(bot?.template).toBe('custom');
    expect(bot?.firstRun).toBe(true);
    expect(bot?.repo).toMatchObject({ repoKey: 'github.com/example/app', repoPath: '/src/app' });
  });

  it('refuses a folder that is not a git checkout with a hosted origin, making nothing', async () => {
    const plain = vi.fn(async () => fail);
    expect(await firstRunBot(store, consented(), req, { git: plain })).toMatchObject({ ok: false, code: 'not_a_repo' });
    const noOrigin = vi.fn(async (args: string[]) => (args[0] === 'rev-parse' ? ok('/src/app\n') : fail));
    expect(await firstRunBot(store, consented(), req, { git: noOrigin, realpath: (p) => p })).toMatchObject({ ok: false, code: 'no_remote' });
    expect(store.list()).toHaveLength(0);
  });

  it('only the main window may ask for it', async () => {
    const r = await firstBotHandler(() => null, { store: () => store, settings: () => consented() })({ sender: {} }, req);
    expect(r).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(0);
  });
});

describe('checkFirstRunFolder', () => {
  it('answers the git root, shortened under home, and its repository', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return ok('/home/me/app\n');
      if (args.includes('config')) return ok('local\0remote.origin.url\nhttps://github.com/example/app.git\0');
      return ok('https://github.com/example/app.git\n');
    });
    expect(await checkFirstRunFolder('/home/me/app/src', { git, realpath: (p) => p, homeDir: '/home/me' }))
      .toEqual({ ok: true, root: '/home/me/app', displayRoot: '~/app', repoKey: 'github.com/example/app' });
    expect(await checkFirstRunFolder('/tmp/plain', { git: vi.fn(async () => fail) })).toMatchObject({ ok: false, code: 'not_a_repo' });
  });
});
