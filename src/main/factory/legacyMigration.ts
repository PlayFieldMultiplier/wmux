// ─── Migration: Moa's settings → the factory ───────────────────────────────
//
// One factory migration step (migrate.ts), idempotent, writing only factory
// files. The legacy files stay in place; they are deleted, after a backup,
// when the code that reads them goes.
//
//   deck-hq.json → factory/settings.json, only when deck-hq.json exists and
//     settings.json does not: hqWorkspaceId (kept readable, used by nothing)
//     and trustedAuthors = moaTrustedAuthors, the morning wake at its default
//     (09:00, Monday–Friday). The factory stays off: Moa being on says
//     nothing about wanting bots (owner decision, 2026-10-14).
//   deck-decisions.json v1 → v2 is the decision store's own read migration.
//
// No bot is created. Builds before 2026-10-14 made a Moa bot in the HQ
// workspace and a parked Lead bot per workspace whose brain was on; step
// 2 → 3 (legacyBotCleanup.ts) removes the ones the owner never talked to.
// A legacy file that cannot be read contributes nothing and leaves a note.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { DEFAULT_FACTORY_SETTINGS, FACTORY_SETTINGS_VERSION } from '../../shared/factorySettings';
import { factorySettingsPath, mergeFactorySettings } from './factorySettings';
import type { FactoryMigrationContext } from './migrate';

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

export function migrateLegacyMoa(ctx: FactoryMigrationContext): void {
  const hq = readJson(path.join(ctx.wmuxDir, 'deck-hq.json'), ctx.notes);
  // Settings: never over a settings file the factory already has.
  const settingsFile = factorySettingsPath(ctx.wmuxDir);
  if (!hq || fs.existsSync(settingsFile)) return;
  const settings = mergeFactorySettings({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] } }, {
    hqWorkspaceId: typeof hq.hqWorkspaceId === 'string' ? hq.hqWorkspaceId : null,
    trustedAuthors: Array.isArray(hq.moaTrustedAuthors) ? hq.moaTrustedAuthors : [],
  });
  atomicWriteJSONSync(settingsFile, { ...settings, version: FACTORY_SETTINGS_VERSION });
  ctx.notes.push('factory settings from deck-hq.json (factory off)');
}
