// deck-hq.json / deck-autonomy.json → factory settings and bots, through the
// shipped migration chain on fixture files: what lands, what the stores read
// back, idempotency, and that legacy files are left in place.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FACTORY_MIGRATION_STEPS, runFactoryMigrations } from '../migrate';
import { migrateLegacyMoa, activeAutonomyWorkspaces } from '../legacyMigration';
import { BotStore, botsFilePath } from '../botStore';
import { FactorySettingsStore, factorySettingsPath } from '../factorySettings';
import { defaultTriggers } from '../roleDefaults';
import { DEFAULT_BOT_BUDGETS } from '../../../shared/bot';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-legacy-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
const HQ = { hqWorkspaceId: 'ws-hq', moaEnabled: true, moaTrustedAuthors: ['alice', 'bad login!'], moaAskMode: 'auto', moaLevel: 2 };
const AUTONOMY = {
  'ws-a': { mode: 'assist', wakePolicy: 'value-filtered', summarize: true, continueInstruction: true, approvalPress: false },
  'ws-b': { mode: 'off', wakePolicy: 'none', summarize: false, continueInstruction: false, approvalPress: false },
  'ws-c': { mode: 'danger', summarize: true, continueInstruction: true, approvalPress: true },
  'ws-legacy': { approvalPress: true },
  'bad id!': { mode: 'danger' },
};

function load() {
  const settings = new FactorySettingsStore(factorySettingsPath(dir)).load();
  const store = new BotStore(botsFilePath(dir));
  store.load();
  return { settings, bots: store.list() };
}

describe('legacy Moa migration (step 1 → 2)', () => {
  it('is the step after the hand-off import', () => {
    expect(FACTORY_MIGRATION_STEPS.map((s) => [s.fromVersion, s.toVersion])).toEqual([[0, 1], [1, 2]]);
  });

  it('Moa on: settings from deck-hq.json, an enabled HQ moa bot, and parked leads where a brain was on', () => {
    write('deck-hq.json', HQ);
    write('deck-autonomy.json', AUTONOMY);
    const r = runFactoryMigrations(dir, { now: 1000 });
    expect(r.to).toBe(FACTORY_MIGRATION_STEPS.length);
    const { settings, bots } = load();
    expect(settings).toMatchObject({ enabled: true, hqWorkspaceId: 'ws-hq', trustedAuthors: ['alice'], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] }, laneAutoMerge: false });
    const moa = bots.find((b) => b.role === 'moa');
    expect(moa).toMatchObject({ workspaceId: 'ws-hq', enabled: true, name: 'Moa', triggers: defaultTriggers('moa'), budget: DEFAULT_BOT_BUDGETS.moa });
    const leads = bots.filter((b) => b.role === 'lead');
    expect(leads.map((b) => b.workspaceId).sort()).toEqual(['ws-a', 'ws-c', 'ws-legacy']);
    expect(leads.every((b) => b.enabled === false)).toBe(true);
    // Legacy files are untouched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'deck-hq.json'), 'utf8'))).toEqual(HQ);
    expect(fs.existsSync(path.join(dir, 'deck-autonomy.json'))).toBe(true);
  });

  it('Moa off or never set: the factory stays off and no moa bot is made', () => {
    write('deck-hq.json', { hqWorkspaceId: 'ws-hq' });
    runFactoryMigrations(dir);
    const { settings, bots } = load();
    expect(settings.enabled).toBe(false);
    expect(bots).toEqual([]);
  });

  it('idempotent: a re-run adds nothing and keeps the settings the owner changed since', () => {
    write('deck-hq.json', HQ);
    write('deck-autonomy.json', AUTONOMY);
    const ctx = () => ({ wmuxDir: dir, factoryDir: path.join(dir, 'factory'), now: 1, notes: [] as string[] });
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    migrateLegacyMoa(ctx());
    const first = load().bots.map((b) => b.id).sort();
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: false }));
    const again = ctx();
    migrateLegacyMoa(again);
    expect(load().bots.map((b) => b.id).sort()).toEqual(first);
    expect(load().settings.enabled).toBe(false);
    expect(again.notes).toEqual([]);
  });

  it('an existing bots.json keeps its bots; a workspace that has a lead gets no second one', () => {
    write('deck-autonomy.json', { 'ws-a': { mode: 'assist' } });
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    const store = new BotStore(botsFilePath(dir));
    const lead = store.create({ workspaceId: 'ws-a', role: 'lead', enabled: true });
    const other = store.create({ workspaceId: 'ws-z', role: 'verifier' });
    expect(lead.ok && other.ok).toBe(true);
    return store.flush().then(() => {
      runFactoryMigrations(dir);
      const { bots } = load();
      expect(bots).toHaveLength(2);
      expect(bots.find((b) => b.role === 'lead')?.enabled).toBe(true);
    });
  });

  it('an unreadable legacy file is noted and migrates nothing; no legacy files: no settings file', () => {
    fs.writeFileSync(path.join(dir, 'deck-hq.json'), '{not json');
    const r = runFactoryMigrations(dir);
    expect(r.notes.some((n) => n.includes('deck-hq.json could not be read'))).toBe(true);
    expect(fs.existsSync(factorySettingsPath(dir))).toBe(false);
    expect(fs.existsSync(botsFilePath(dir))).toBe(false);
  });

  it('reads the autonomy mode the way the deck did (legacy caps, manual = off)', () => {
    expect(activeAutonomyWorkspaces({
      a: { mode: 'assist' }, b: { mode: 'manual' }, c: { continueInstruction: true }, d: {}, e: { mode: 'off' },
    })).toEqual(['a', 'c']);
    expect(activeAutonomyWorkspaces(null)).toEqual([]);
  });
});
