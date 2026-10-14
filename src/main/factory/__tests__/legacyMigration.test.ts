// deck-hq.json → factory settings (factory off, no bots), and the removal of
// the Moa-era bots an earlier build of that step made, through the shipped
// migration chain on fixture files.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FACTORY_MIGRATION_STEPS, runFactoryMigrations } from '../migrate';
import { migrateLegacyMoa } from '../legacyMigration';
import { botsTalkedTo, isLegacyMigrationBot } from '../legacyBotCleanup';
import { BotStore, botsFilePath } from '../botStore';
import { FactorySettingsStore, factorySettingsPath } from '../factorySettings';

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
  it('is the step after the hand-off import, and the bot cleanup follows it', () => {
    expect(FACTORY_MIGRATION_STEPS.map((s) => [s.fromVersion, s.toVersion])).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it('Moa on: settings from deck-hq.json, but the factory stays off and no bot is made', () => {
    write('deck-hq.json', HQ);
    write('deck-autonomy.json', AUTONOMY);
    const r = runFactoryMigrations(dir, { now: 1000 });
    expect(r.to).toBe(FACTORY_MIGRATION_STEPS.length);
    const { settings, bots } = load();
    expect(settings).toMatchObject({ enabled: false, hqWorkspaceId: 'ws-hq', trustedAuthors: ['alice'], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] }, laneAutoMerge: false });
    expect(bots).toEqual([]);
    expect(fs.existsSync(botsFilePath(dir))).toBe(false);
    // Legacy files are untouched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'deck-hq.json'), 'utf8'))).toEqual(HQ);
    expect(fs.existsSync(path.join(dir, 'deck-autonomy.json'))).toBe(true);
  });

  it('idempotent: a re-run keeps the settings the owner changed since', () => {
    write('deck-hq.json', HQ);
    const ctx = () => ({ wmuxDir: dir, factoryDir: path.join(dir, 'factory'), now: 1, notes: [] as string[] });
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    migrateLegacyMoa(ctx());
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true }));
    const again = ctx();
    migrateLegacyMoa(again);
    expect(load().settings.enabled).toBe(true);
    expect(again.notes).toEqual([]);
  });

  it('an unreadable legacy file is noted and migrates nothing; no legacy files: no settings file', () => {
    fs.writeFileSync(path.join(dir, 'deck-hq.json'), '{not json');
    const r = runFactoryMigrations(dir);
    expect(r.notes.some((n) => n.includes('deck-hq.json could not be read'))).toBe(true);
    expect(fs.existsSync(factorySettingsPath(dir))).toBe(false);
    expect(fs.existsSync(botsFilePath(dir))).toBe(false);
  });
});

describe('Moa-era bot cleanup (step 2 → 3)', () => {
  const RUN_AT = 1_700_000_000_000;
  const bot = (id: string, role: string, name: string, enabled: boolean, createdAt = RUN_AT) => ({
    version: 1, id, workspaceId: 'ws-hq', role, template: role === 'moa' ? 'coordinator' : 'lead', name,
    engine: { kind: 'claude-sdk' }, triggers: [], budget: { maxTurnsPerDay: 10, maxConcurrentWorkers: 1 },
    enabled, createdAt, updatedAt: createdAt,
  });
  const MOA = 'bot-aaaa0001';
  const LEAD = 'bot-aaaa0002';
  const LEAD_ON = 'bot-aaaa0003';
  const TALKED = 'bot-aaaa0004';
  const MINE = 'bot-aaaa0005';
  function seed(): void {
    fs.mkdirSync(path.join(dir, 'factory', 'rooms'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'migration.json'), JSON.stringify({ version: 2, migratedAt: RUN_AT }));
    fs.writeFileSync(botsFilePath(dir), JSON.stringify({
      version: 1,
      bots: [
        bot(MOA, 'moa', 'Moa', true),
        bot(LEAD, 'lead', 'Lead', false),
        bot(LEAD_ON, 'lead', 'Lead', true),
        bot(TALKED, 'lead', 'Lead', false),
        // The owner's own bot, even with the same role and name: another clock.
        bot(MINE, 'moa', 'Moa', true, RUN_AT + 5),
      ],
      usage: { [MOA]: { x: 1 }, [MINE]: { x: 2 } },
    }));
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true, phoneBotId: MOA }));
    fs.writeFileSync(path.join(dir, 'factory', 'rooms', 'ws-a.jsonl'), [
      JSON.stringify({ version: 1, id: 'c1', seq: 1, kind: 'status', actor: { kind: 'bot', botId: MOA }, refs: { botIds: [MOA] } }),
      '{torn',
      JSON.stringify({ version: 1, id: 'c2', seq: 2, kind: 'human', actor: { kind: 'human' }, refs: { botIds: [TALKED], botId: TALKED } }),
      '',
    ].join('\n'));
  }
  const ids = () => (JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8')) as { bots: { id: string }[] }).bots.map((b) => b.id);

  it('removes the migration-made Moa and parked Lead the owner never talked to, with a backup', () => {
    seed();
    const r = runFactoryMigrations(dir, { now: RUN_AT + 99 });
    expect(r).toMatchObject({ from: 2, to: 3 });
    expect(r.notes.some((n) => n.includes('removed 2 Moa-era bot(s)'))).toBe(true);
    expect(ids()).toEqual([LEAD_ON, TALKED, MINE]);
    const stored = JSON.parse(fs.readFileSync(botsFilePath(dir), 'utf8')) as { usage: Record<string, unknown> };
    expect(Object.keys(stored.usage)).toEqual([MINE]);
    expect(JSON.parse(fs.readFileSync(`${botsFilePath(dir)}.premigrate`, 'utf8')).bots).toHaveLength(5);
    // The phone pin named a removed bot: cleared, the rest kept.
    expect(JSON.parse(fs.readFileSync(factorySettingsPath(dir), 'utf8'))).toEqual({ version: 1, enabled: true });
    // What the store reads back.
    expect(load().bots.map((b) => b.id).sort()).toEqual([LEAD_ON, MINE, TALKED].sort());
  });

  it('idempotent: a second run of the step removes nothing more', () => {
    seed();
    runFactoryMigrations(dir, { now: RUN_AT + 99 });
    fs.writeFileSync(path.join(dir, 'factory', 'migration.json'), JSON.stringify({ version: 2, migratedAt: RUN_AT }));
    const again = runFactoryMigrations(dir, { now: RUN_AT + 100 });
    expect(again.notes).toEqual([]);
    expect(ids()).toEqual([LEAD_ON, TALKED, MINE]);
  });

  it('a marker without migratedAt, or unreadable rooms, removes nothing', () => {
    seed();
    fs.writeFileSync(path.join(dir, 'factory', 'migration.json'), JSON.stringify({ version: 2 }));
    runFactoryMigrations(dir);
    expect(ids()).toHaveLength(5);
    expect(botsTalkedTo(path.join(dir, 'factory', 'no-such-rooms'))).toEqual(new Set());
    fs.writeFileSync(path.join(dir, 'factory', 'rooms-file'), '');
    expect(botsTalkedTo(path.join(dir, 'factory', 'rooms-file'))).toBeNull();
  });

  it('a room at the card cap (its oldest cards may be gone) removes nothing', () => {
    seed();
    const rooms = path.join(dir, 'factory', 'rooms');
    expect(botsTalkedTo(rooms, 3)?.has(TALKED)).toBe(true);
    fs.writeFileSync(path.join(rooms, 'ws-full.jsonl'), ['c1', 'c2', 'c3'].map((id, i) => JSON.stringify({ version: 1, id, seq: i + 1, kind: 'status' })).join('\n'));
    expect(botsTalkedTo(rooms, 3)).toBeNull();
  });

  it('recognizes only the shape the old step wrote', () => {
    expect(isLegacyMigrationBot(bot(MOA, 'moa', 'Moa', true), RUN_AT)).toBe(true);
    expect(isLegacyMigrationBot(bot(MOA, 'moa', 'Moa (mine)', true), RUN_AT)).toBe(false);
    expect(isLegacyMigrationBot(bot(LEAD, 'lead', 'Lead', true), RUN_AT)).toBe(false);
    expect(isLegacyMigrationBot(bot(LEAD, 'verifier', 'Lead', false), RUN_AT)).toBe(false);
    expect(isLegacyMigrationBot(null, RUN_AT)).toBe(false);
  });
});
