// The guest workspace flag (guestWorkspaces.ts): its three states, the
// add-only writer, a file that cannot be read, and the union the clean side
// reads.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GuestWorkspaceStore,
  __resetGuestWorkspacesForTesting,
  crossesGuestBoundary,
  expectGuestWorkspaces,
  guestSide,
  guestWorkspaceBotRefusal,
  guestWorkspaceFlag,
  guestWorkspacesPath,
  isGuestWorkspace,
  noteGuestRecordWorkspaces,
  setGuestWorkspaceStore,
} from '../guestWorkspaces';
import { FactorySettingsStore, HQ_NOT_GUEST_WORKSPACE, factorySettingsPath } from '../factorySettings';
import { BotStore, botsFilePath } from '../botStore';

let dir = '';
const file = (): string => guestWorkspacesPath(dir);
const store = (roomsDir?: string): GuestWorkspaceStore => new GuestWorkspaceStore({ file: file(), ...(roomsDir ? { roomsDir } : {}), now: () => 1_000_000, log: () => undefined });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-ws-'));
  __resetGuestWorkspacesForTesting();
});

/** Stores whose writes run past their test: awaited before the folder goes. */
const writing: Array<{ flush(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of writing.splice(0)) await s.flush().catch(() => undefined);
  __resetGuestWorkspacesForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GuestWorkspaceStore', () => {
  it('a missing file flags nothing; a flag is on disk once add resolves and survives a reload', async () => {
    const s = store();
    s.load();
    expect(s.flag('ws-1')).toBe(false);
    await s.add('ws-1');
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.workspaces)).toEqual(['ws-1']);
    const again = store();
    again.load();
    expect(again.flag('ws-1')).toBe(true);
    expect(again.flag('ws-2')).toBe(false);
    expect(again.list().map((e) => e.workspaceId)).toEqual(['ws-1']);
  });

  it('is unknown before it loads', () => {
    expect(store().flag('ws-1')).toBe('unknown');
  });

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ version: 2, workspaces: {} })],
    ['a malformed entry', JSON.stringify({ version: 1, workspaces: { 'ws-1': { since: 'never' } } })],
    ['no workspaces', JSON.stringify({ version: 1 })],
  ])('a file with %s is unknown, refuses a flag and is never overwritten', async (_what, body) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), body);
    const s = store();
    s.load();
    expect(s.readable()).toBe(false);
    expect(s.flag('ws-1')).toBe('unknown');
    expect(s.isGuest('ws-9', new Set())).toBe('unknown');
    await expect(s.add('ws-1')).rejects.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe(body);
  });

  it('counts a room that already holds a guest card, never one that only quotes the word', () => {
    const rooms = path.join(dir, 'factory', 'rooms');
    fs.mkdirSync(rooms, { recursive: true });
    fs.writeFileSync(path.join(rooms, 'ws-old.jsonl'), `${JSON.stringify({ version: 1, kind: 'guest', title: 'External guest: A' })}\n`);
    fs.writeFileSync(path.join(rooms, 'ws-clean.jsonl'), `${JSON.stringify({ version: 1, kind: 'human', title: '"kind":"guest"' })}\n`);
    const s = store(rooms);
    s.load();
    expect(s.isGuest('ws-old', new Set())).toBe(true);
    // The flag (what a guest needs) stays unset.
    expect(s.flag('ws-old')).toBe(false);
    expect(s.isGuest('ws-clean', new Set())).toBe(false);
  });
});

describe('the predicate', () => {
  it('reads clean with no store where none is expected, unknown where one is', () => {
    expect(guestWorkspaceFlag('ws-1')).toBe(false);
    expect(guestSide('ws-1')).toBe(false);
    expectGuestWorkspaces();
    expect(guestWorkspaceFlag('ws-1')).toBe('unknown');
    expect(isGuestWorkspace('ws-1')).toBe('unknown');
    // The clean side treats unknown as guest.
    expect(guestSide('ws-1')).toBe(true);
    expect(crossesGuestBoundary('ws-1', 'ws-2')).toBe(true);
    expect(crossesGuestBoundary('ws-1', 'ws-1')).toBe(false);
  });

  it('a daemon record\'s workspace is guest on the clean side but grants no ingress', async () => {
    const s = store();
    s.load();
    setGuestWorkspaceStore(s);
    noteGuestRecordWorkspaces(['ws-rec']);
    expect(isGuestWorkspace('ws-rec')).toBe(true);
    expect(guestWorkspaceFlag('ws-rec')).toBe(false);
    await s.add('ws-g');
    expect(guestWorkspaceFlag('ws-g')).toBe(true);
    expect(crossesGuestBoundary('ws-g', 'ws-a')).toBe(true);
    expect(crossesGuestBoundary('ws-a', 'ws-b')).toBe(false);
  });
});

describe('guestWorkspaceBotRefusal', () => {
  const base = { role: 'lead' as const, template: 'developer' as const, engine: { kind: 'claude-sdk' as const } };
  it('allows a lead-role bot on the gated engine with no repository', () => {
    expect(guestWorkspaceBotRefusal(base)).toBeNull();
    expect(guestWorkspaceBotRefusal({ ...base, template: 'custom' })).toBeNull();
  });
  it.each([
    ['a repository', { repo: { repoKey: 'o/r', repoPath: '/x' } }],
    ['the Coordinator template', { template: 'coordinator' as const }],
    ['the moa role', { role: 'moa' as const, template: 'custom' as const }],
    ['the verifier role', { role: 'verifier' as const, template: 'reviewer' as const }],
    ['the maintainer role', { role: 'maintainer' as const, template: 'custom' as const }],
    ['an ungated engine', { engine: { kind: 'claude-pty' as const } }],
  ])('refuses %s', (_what, patch) => {
    expect(guestWorkspaceBotRefusal({ ...base, ...patch } as never)).not.toBeNull();
  });
});

describe('the HQ workspace', () => {
  it('is never a guest workspace', async () => {
    const s = store();
    s.load();
    setGuestWorkspaceStore(s);
    await s.add('ws-g');
    const settings = new FactorySettingsStore(factorySettingsPath(dir));
    settings.load();
    writing.push({ flush: () => settings.update({}).then(() => undefined) });
    await expect(settings.update({ hqWorkspaceId: 'ws-g' })).rejects.toThrow(HQ_NOT_GUEST_WORKSPACE);
    expect(settings.get().hqWorkspaceId).toBeNull();
    expect((await settings.update({ hqWorkspaceId: 'ws-a' })).hqWorkspaceId).toBe('ws-a');
  });
});

describe('a bot in a guest workspace (BotStore)', () => {
  const guestWs = (ws: string) => ws === 'ws-g';
  const make = () => {
    const s = new BotStore(botsFilePath(dir), { guestWorkspace: guestWs });
    writing.push(s);
    return s;
  };
  const repo = { repoKey: 'o/r', repoPath: '/tmp/r' };

  it('is created only as a lead-role bot with no repository on the gated engine', () => {
    const s = make();
    expect(s.create({ workspaceId: 'ws-g', template: 'developer' }).ok).toBe(true);
    expect(s.create({ workspaceId: 'ws-g', template: 'custom' }).ok).toBe(true);
    for (const input of [
      { template: 'coordinator' }, { role: 'moa' }, { template: 'reviewer' }, { template: 'issue' }, { role: 'maintainer' },
      { template: 'developer', repo }, { template: 'developer', engine: { kind: 'claude-pty' } },
    ]) {
      const r = s.create({ workspaceId: 'ws-g', ...input });
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
    // Elsewhere nothing changes.
    expect(s.create({ workspaceId: 'ws-a', template: 'coordinator', repo }).ok).toBe(true);
  });

  it('is never updated into one that breaks the rules; a bot turned off for one can be fixed field by field', () => {
    const s = make();
    const made = s.create({ workspaceId: 'ws-g', template: 'developer' });
    if (!made.ok) throw new Error('not made');
    const id = made.bot.id;
    for (const patch of [{ template: 'coordinator' }, { repo }, { engine: { kind: 'claude-pty' } }, { template: 'reviewer' }]) {
      expect(s.update(id, patch).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(s.update(id, { name: 'Dev 2' }).ok).toBe(true);
  });

  it('a hand-edited bots.json loads with the breaking bots turned off, not dropped', async () => {
    const seed = new BotStore(botsFilePath(dir));
    const coord = seed.create({ workspaceId: 'ws-g', template: 'coordinator' });
    const withRepo = seed.create({ workspaceId: 'ws-g', template: 'developer', repo });
    const ok = seed.create({ workspaceId: 'ws-g', template: 'developer' });
    const other = seed.create({ workspaceId: 'ws-a', template: 'coordinator' });
    await seed.flush();
    if (!coord.ok || !withRepo.ok || !ok.ok || !other.ok) throw new Error('not made');
    const warn = console.warn;
    console.warn = () => undefined;
    const s = make();
    s.load();
    console.warn = warn;
    expect(s.get(coord.bot.id)?.enabled).toBe(false);
    expect(s.get(withRepo.bot.id)?.enabled).toBe(false);
    expect(s.get(ok.bot.id)?.enabled).toBe(true);
    expect(s.get(other.bot.id)?.enabled).toBe(true);
    expect(s.guestRuleDisabledBots().map((d) => d.botId).sort()).toEqual([coord.bot.id, withRepo.bot.id].sort());
    // Turned on again only once it keeps the rules.
    expect(s.update(withRepo.bot.id, { enabled: true }).ok).toBe(false);
    expect(s.update(withRepo.bot.id, { repo: null }).ok).toBe(true);
    expect(s.update(withRepo.bot.id, { enabled: true }).ok).toBe(true);
    await s.flush();
  });

  it('a list that cannot be read turns nothing off on load but refuses a breaking create', () => {
    const seed = new BotStore(botsFilePath(dir));
    const coord = seed.create({ workspaceId: 'ws-g', template: 'coordinator' });
    if (!coord.ok) throw new Error('not made');
    return seed.flush().then(() => {
      const s = new BotStore(botsFilePath(dir), { guestWorkspace: () => 'unknown' });
      writing.push(s);
      s.load();
      expect(s.get(coord.bot.id)?.enabled).toBe(true);
      expect(s.create({ workspaceId: 'ws-x', template: 'coordinator' }).ok).toBe(false);
    });
  });
});
