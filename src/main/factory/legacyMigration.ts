// ─── Migration: Moa's settings and per-workspace brains → the factory ──────
//
// One factory migration step (migrate.ts), idempotent, writing only factory
// files. The legacy files stay in place; they are deleted, after a backup,
// when the code that reads them goes.
//
//   deck-hq.json → factory/settings.json, only when deck-hq.json exists and
//     settings.json does not: hqWorkspaceId, enabled = moaEnabled === true (opt-in: an
//     absent switch is off), trustedAuthors = moaTrustedAuthors, the morning
//     wake at its default (09:00, Monday–Friday). Moa enabled with an HQ
//     workspace → an enabled Coordinator-template bot named Moa there (the
//     `moa` role's default triggers and budget).
//   deck-autonomy.json → for each workspace whose mode is not `off`, a `lead`
//     bot that is NOT enabled, so nothing starts spending unasked.
//   deck-decisions.json v1 → v2 is the decision store's own read migration.
//
// A bot is created only when its workspace has no bot of that role, so a
// re-run (a crash before the marker write) adds nothing. A legacy file that
// cannot be read contributes nothing and leaves a note.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { DEFAULT_BOT_BUDGETS, templateOfRole, type BotProfile, type BotRole } from '../../shared/bot';
import { DEFAULT_FACTORY_SETTINGS, FACTORY_SETTINGS_VERSION, type FactorySettings } from '../../shared/factorySettings';
import { BOTS_FILE_VERSION, BOTS_MAX, botsFilePath, parseBotProfile } from './botStore';
import { emptyUsage } from './budget';
import { factorySettingsPath, mergeFactorySettings } from './factorySettings';
import { defaultTriggers } from './roleDefaults';
import type { FactoryMigrationContext } from './migrate';

const NAMES: Readonly<Record<'moa' | 'lead', string>> = { moa: 'Moa', lead: 'Lead' };

function readJson(file: string, notes: string[]): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = atomicReadJSONSync<unknown>(file);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* noted below */
  }
  notes.push(`${path.basename(file)} could not be read; it was not migrated`);
  return null;
}

function newBot(workspaceId: string, role: 'moa' | 'lead', enabled: boolean, now: number, taken: Set<string>): BotProfile | null {
  let id = `bot-${randomBytes(4).toString('hex')}`;
  for (let i = 0; taken.has(id) && i < 8; i++) id = `bot-${randomBytes(4).toString('hex')}`;
  return parseBotProfile({
    version: 1,
    id,
    workspaceId,
    role,
    template: templateOfRole(role),
    name: NAMES[role],
    engine: { ...DEFAULT_FACTORY_SETTINGS.defaultEngine },
    triggers: defaultTriggers(role as BotRole),
    budget: { ...DEFAULT_BOT_BUDGETS[role] },
    enabled,
    createdAt: now,
    updatedAt: now,
  });
}

/** The workspaces whose legacy autonomy mode is not `off`. */
export function activeAutonomyWorkspaces(raw: Record<string, unknown> | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const [ws, entry] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(ws) || !entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    // A mode-less entry predates the field: its caps decide (deriveMode).
    const mode = typeof e.mode === 'string'
      ? e.mode
      : e.approvalPress === true ? 'danger' : e.continueInstruction === true ? 'assist' : 'off';
    if (mode !== 'off' && mode !== 'manual') out.push(ws);
  }
  return out;
}

export function migrateLegacyMoa(ctx: FactoryMigrationContext): void {
  const hq = readJson(path.join(ctx.wmuxDir, 'deck-hq.json'), ctx.notes);
  const autonomy = readJson(path.join(ctx.wmuxDir, 'deck-autonomy.json'), ctx.notes);

  // Settings: never over a settings file the factory already has.
  const settingsFile = factorySettingsPath(ctx.wmuxDir);
  let settings: FactorySettings | null = null;
  if (hq && !fs.existsSync(settingsFile)) {
    settings = mergeFactorySettings({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] } }, {
      enabled: hq?.moaEnabled === true,
      hqWorkspaceId: typeof hq?.hqWorkspaceId === 'string' ? hq.hqWorkspaceId : null,
      trustedAuthors: Array.isArray(hq?.moaTrustedAuthors) ? hq.moaTrustedAuthors : [],
    });
    atomicWriteJSONSync(settingsFile, { ...settings, version: FACTORY_SETTINGS_VERSION });
    ctx.notes.push(`factory settings from deck-hq.json (factory ${settings.enabled ? 'on' : 'off'})`);
  }

  // Bots: added to bots.json beside whatever it holds.
  const botsFile = botsFilePath(ctx.wmuxDir);
  const current = readJson(botsFile, ctx.notes);
  if (current && current.version !== BOTS_FILE_VERSION) {
    ctx.notes.push('bots.json has another version; no bots were added');
    return;
  }
  if (fs.existsSync(botsFile) && !current) return;
  const bots: unknown[] = Array.isArray(current?.bots) ? [...(current?.bots as unknown[])] : [];
  const usage: Record<string, unknown> = current?.usage && typeof current.usage === 'object' ? { ...(current.usage as Record<string, unknown>) } : {};
  const parsed = bots.map(parseBotProfile).filter((b): b is BotProfile => b !== null);
  const has = (ws: string, role: BotRole) => parsed.some((b) => b.workspaceId === ws && b.role === role);
  const taken = new Set(parsed.map((b) => b.id));
  let added = 0;
  const add = (b: BotProfile | null): void => {
    if (!b || bots.length >= BOTS_MAX) return;
    added += 1;
    bots.push(b);
    parsed.push(b);
    taken.add(b.id);
    usage[b.id] = emptyUsage();
  };
  const hqWorkspaceId = typeof hq?.hqWorkspaceId === 'string' ? hq.hqWorkspaceId : null;
  if (hq?.moaEnabled === true && hqWorkspaceId && !parsed.some((b) => b.role === 'moa')) {
    add(newBot(hqWorkspaceId, 'moa', true, ctx.now, taken));
  }
  for (const ws of activeAutonomyWorkspaces(autonomy)) {
    if (!has(ws, 'lead')) add(newBot(ws, 'lead', false, ctx.now, taken));
  }
  if (added === 0) return;
  atomicWriteJSONSync(botsFile, { version: BOTS_FILE_VERSION, bots, usage });
  ctx.notes.push(`added ${added} bot profile(s) from the Moa and per-workspace brain settings`);
}
