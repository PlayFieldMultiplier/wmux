// ─── Factory migrations — one-shot moves of the old Moa/Deck files ─────────
//
// Run once per app start by the factory host before any module starts
// (factoryHost.ts). The version reached is recorded in
// `factory/migration.json` ({version}); the chain is walked by the shared
// engine (daemon/util/atomicWrite/migrate.ts `applyMigrations`, strict +1
// hops). The registry's current version is the number of steps, so the chain
// is empty — and running it a no-op that writes nothing — until the first step
// lands; a later step can therefore never be skipped by a marker an earlier
// build wrote.
//
// A step does its own file I/O through the context and must be idempotent: a
// crash after a step but before the marker write runs it again on the next
// start. Back up what a step deletes (quarantineFileSync / a `.premigrate`
// copy) before deleting it.

import fs from 'node:fs';
import path from 'node:path';
import {
  applyMigrations,
  atomicReadJSONSync,
  atomicWriteJSONSync,
  type MigrationRegistry,
  type MigrationStep,
} from '../../daemon/util/atomicWrite';
import { importLegacyMoaHandoffs } from './handoffRouter';
import { migrateLegacyMoa } from './legacyMigration';

export interface FactoryMigrationContext {
  /** getWmuxDir() */
  wmuxDir: string;
  /** `<wmuxDir>/factory`, created before the first step runs. */
  factoryDir: string;
  now: number;
  /** Human-readable notes a step leaves for the log. */
  notes: string[];
}

export type FactoryMigrationStep = MigrationStep<FactoryMigrationContext, FactoryMigrationContext>;

/** The steps, in order: step i moves version i → i+1. */
export const FACTORY_MIGRATION_STEPS: readonly FactoryMigrationStep[] = [
  // Moa's hand-offs (moa-handoffs.json) become depth-0 handoffs in
  // factory/handoffs.jsonl. The legacy file stays until moaHandoff.ts goes.
  {
    fromVersion: 0,
    toVersion: 1,
    migrate: (ctx) => {
      const n = importLegacyMoaHandoffs(ctx);
      if (n > 0) ctx.notes.push(`imported ${n} Moa hand-offs into handoffs.jsonl`);
      return ctx;
    },
  },
  // Moa's settings (deck-hq.json) become factory/settings.json and, when Moa
  // was on, the HQ moa bot; a workspace whose brain was on gets a lead bot
  // that is not enabled (legacyMigration.ts). Legacy files stay.
  {
    fromVersion: 1,
    toVersion: 2,
    migrate: (ctx) => {
      migrateLegacyMoa(ctx);
      return ctx;
    },
  },
];

export function factoryMigrationRegistry(
  steps: readonly FactoryMigrationStep[] = FACTORY_MIGRATION_STEPS,
): MigrationRegistry {
  return { currentVersion: steps.length, steps: steps as MigrationStep[] };
}

export function factoryMigrationMarkerPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'migration.json');
}

/** The recorded version: 0 when the marker is missing; throws on a marker
 *  that is not a non-negative integer version (never guesses). */
export function readFactoryMigrationVersion(wmuxDir: string): number {
  const file = factoryMigrationMarkerPath(wmuxDir);
  if (!fs.existsSync(file)) return 0;
  const raw = atomicReadJSONSync<unknown>(file);
  const version = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`factory migration marker ${file} is unreadable`);
  }
  return version;
}

export interface FactoryMigrationResult {
  from: number;
  to: number;
  notes: string[];
}

/** Walk the chain from the recorded version to the current one and record
 *  the result. Idempotent: at the current version it reads one file and
 *  writes nothing. Throws when a step fails (the marker is left as it was). */
export function runFactoryMigrations(
  wmuxDir: string,
  opts: { steps?: readonly FactoryMigrationStep[]; now?: number } = {},
): FactoryMigrationResult {
  const registry = factoryMigrationRegistry(opts.steps);
  const from = readFactoryMigrationVersion(wmuxDir);
  if (from >= registry.currentVersion) return { from, to: from, notes: [] };
  const factoryDir = path.join(wmuxDir, 'factory');
  fs.mkdirSync(factoryDir, { recursive: true });
  const ctx: FactoryMigrationContext = { wmuxDir, factoryDir, now: opts.now ?? Date.now(), notes: [] };
  const { data, version } = applyMigrations<FactoryMigrationContext>(ctx, from, registry);
  atomicWriteJSONSync(factoryMigrationMarkerPath(wmuxDir), { version, migratedAt: ctx.now });
  return { from, to: version, notes: data.notes };
}
