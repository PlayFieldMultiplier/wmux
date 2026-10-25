// bot.update with a picked folder (the Bots page profile's Change): the repo
// becomes the workspace's, remembered in workspace-repos.json and given to
// the workspace's bots without one; another repository there stays refused.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('../../../deck/taskLedgerHost', () => ({ getTaskLedger: () => ({ onTransition: () => () => undefined, get: () => null, list: () => [] }) }));

import type { RpcContext } from '../../../../shared/rpc';
import { registerBotRpcHandlers } from '../bot.rpc';
import { BotStore, botsFilePath } from '../../../factory/botStore';
import { WorkspaceRepoStore, setWorkspaceRepoStore, workspaceReposPath } from '../../../factory/workspaceRepos';
import { persisterWritesSettled } from '../../../factory/versionedFile';
import type { BotRuntime } from '../../../factory/BotRuntime';
import type { FactoryRouter } from '../../../factory/factoryHost';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfui-botrpc-wsrepo-'));
});
afterEach(async () => {
  setWorkspaceRepoStore(null);
  await persisterWritesSettled();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A checkout whose origin names `key` (no network: origin is never read). */
function checkout(name: string, key: string): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${key}.git`], { cwd: repo });
  return repo;
}

function rig() {
  const store = new BotStore(botsFilePath(dir));
  const records = new WorkspaceRepoStore({ file: workspaceReposPath(dir) });
  records.load();
  setWorkspaceRepoStore(records);
  const changed = vi.fn();
  const runtime = { profileChanged: changed, status: () => null } as unknown as BotRuntime;
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h), onBotRefused: () => () => undefined } as unknown as FactoryRouter;
  registerBotRpcHandlers(router, () => ({ store, runtime }));
  const update = (botId: string, patch: Record<string, unknown>) => (handlers.get('bot.update') as Handler)({ botId, patch }, OPERATOR);
  const make = (name: string, workspaceId = 'ws-1') => {
    const r = store.create({ workspaceId, name });
    if (!r.ok) throw new Error('create');
    return r.bot.id;
  };
  return { store, records, changed, update, make };
}

describe('bot.update repoFolder: the workspace\'s repository', () => {
  it('fills the workspace\'s bots without a repository, remembers it, and leaves other workspaces alone', async () => {
    const r = rig();
    const app = checkout('app', 'acme/app');
    const lead = r.make('Lead');
    const dev = r.make('Dev');
    const rev = r.make('Rev');
    const elsewhere = r.make('Far', 'ws-2');
    expect(await r.update(lead, { repoFolder: app })).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
    for (const id of [dev, rev]) expect(r.store.get(id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app', repoPath: fs.realpathSync.native(app) });
    expect(r.store.get(elsewhere)?.repo).toBeUndefined();
    expect(r.changed.mock.calls.map((c) => c[0]).sort()).toEqual([lead, dev, rev].sort());
    expect(r.records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    expect(r.records.get('ws-2')).toBeNull();
    await r.store.flush();
  });

  it('another repository on a filled bot is repo_mismatch, and changes nothing', async () => {
    const r = rig();
    const app = checkout('app', 'acme/app');
    const api = checkout('api', 'acme/api');
    const lead = r.make('Lead');
    const dev = r.make('Dev');
    expect(await r.update(lead, { repoFolder: app })).toMatchObject({ ok: true });
    expect(await r.update(dev, { repoFolder: api })).toMatchObject({ ok: false, code: 'repo_mismatch' });
    expect(r.store.get(dev)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(r.records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    await r.store.flush();
  });

  it('a `repo` patch itself is checked against the other bots, then remembered and given to the bots without one', async () => {
    const r = rig();
    const lead = r.make('Lead');
    const dev = r.make('Dev');
    const app = { repoKey: 'github.com/acme/app', repoPath: path.join(dir, 'app') };
    expect(await r.update(lead, { repo: app })).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
    expect(r.store.get(dev)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(r.changed).toHaveBeenCalledWith(dev);
    expect(r.records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    expect(await r.update(dev, { repo: { repoKey: 'github.com/acme/api', repoPath: path.join(dir, 'api') } })).toMatchObject({ ok: false, code: 'repo_mismatch' });
    expect(r.store.get(dev)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    await r.store.flush();
  });
});
