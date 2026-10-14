// ─── Migration: remove the bots the old Moa migration made, if unused ──────
//
// Builds before 2026-10-14 ran step 1 → 2 (legacyMigration.ts) with bot
// creation: an enabled Moa bot (role `moa`) in the HQ workspace when Moa was
// on, and a parked Lead bot (role `lead`, not enabled) per workspace whose
// brain was on. The owner did not ask for them (owner decision, 2026-10-14),
// so step 2 → 3 removes each one the owner never talked to.
//
// A bot counts as made by that migration when its createdAt equals the
// `migratedAt` the same run wrote into factory/migration.json (both were that
// run's clock), it has the role and default name the migration gave it
// (Moa / Lead), and, for a Lead, it is still not enabled (the owner turning
// one on keeps it). It counts as talked to when any `human` card in any room
// (factory/rooms/*.jsonl) is addressed to it (refs.botIds / refs.botId).
// Rooms and that migration shipped together (4.4.0), and room retention only
// drops cards older than ROOM_LIMITS.RETAIN_DAYS (90), so a card the owner
// wrote cannot have aged out before this step's first run; the card cap
// (ROOM_STORE_LIMITS.MAX_CARDS) can drop old cards sooner, so a room at the
// cap counts as unreadable. When the rooms cannot be read, nothing is
// removed.
//
// Removing a bot is what the bot store does on remove: the profile and its
// usage go; a phone pin (settings.phoneBotId) naming it is cleared. bots.json
// is copied to bots.json.premigrate first. Idempotent: a re-run finds nothing
// left to remove.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { BOT_ID_RE } from '../../shared/bot';
import { BOTS_FILE_VERSION, botsFilePath } from './botStore';
import { ROOM_STORE_LIMITS } from './roomWriter';
import { factorySettingsPath } from './factorySettings';
import type { FactoryMigrationContext } from './migrate';

const LEGACY_NAMES: Readonly<Record<string, string>> = { moa: 'Moa', lead: 'Lead' };

/** The bot ids an owner message in the rooms was addressed to, or null when
 *  the rooms folder exists but cannot be read, or a room is at the card cap
 *  (its oldest cards may be gone). */
export function botsTalkedTo(roomsDir: string, maxCards: number = ROOM_STORE_LIMITS.MAX_CARDS): Set<string> | null {
  const out = new Set<string>();
  let names: string[];
  try {
    names = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir).filter((n) => n.endsWith('.jsonl')) : [];
  } catch {
    return null;
  }
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(roomsDir, name), 'utf8');
    } catch {
      return null;
    }
    const cardIds = new Set<string>();
    for (const line of text.split('\n')) {
      const id = /"id":"([^"]{1,200})"/.exec(line)?.[1];
      if (id) cardIds.add(id);
      if (!line.includes('"human"')) continue;
      let card: unknown;
      try {
        card = JSON.parse(line);
      } catch {
        continue;
      }
      if (!card || typeof card !== 'object') continue;
      const c = card as { kind?: unknown; actor?: { kind?: unknown }; refs?: { botIds?: unknown; botId?: unknown } };
      if (c.kind !== 'human' && c.actor?.kind !== 'human') continue;
      const ids = [...(Array.isArray(c.refs?.botIds) ? c.refs.botIds : []), c.refs?.botId];
      for (const id of ids) if (typeof id === 'string' && BOT_ID_RE.test(id)) out.add(id);
    }
    if (cardIds.size >= maxCards) return null;
  }
  return out;
}

/** Whether a stored bot is one the old migration made (see the header). */
export function isLegacyMigrationBot(raw: unknown, migratedAt: number): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const b = raw as { role?: unknown; name?: unknown; createdAt?: unknown; enabled?: unknown };
  if (typeof b.role !== 'string' || !(b.role in LEGACY_NAMES)) return false;
  if (b.name !== LEGACY_NAMES[b.role] || b.createdAt !== migratedAt) return false;
  return b.role === 'moa' || b.enabled !== true;
}

export function removeUntouchedLegacyBots(ctx: FactoryMigrationContext): void {
  const migratedAt = ctx.previousMigratedAt;
  if (typeof migratedAt !== 'number') return;
  const botsFile = botsFilePath(ctx.wmuxDir);
  if (!fs.existsSync(botsFile)) return;
  let current: Record<string, unknown>;
  try {
    const raw = atomicReadJSONSync<unknown>(botsFile);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    current = raw as Record<string, unknown>;
  } catch {
    ctx.notes.push('bots.json could not be read; no Moa-era bots were removed');
    return;
  }
  if (current.version !== BOTS_FILE_VERSION || !Array.isArray(current.bots)) {
    ctx.notes.push('bots.json has another version; no Moa-era bots were removed');
    return;
  }
  const candidates = current.bots.filter((b) => isLegacyMigrationBot(b, migratedAt));
  if (candidates.length === 0) return;
  const talked = botsTalkedTo(path.join(ctx.factoryDir, 'rooms'));
  if (!talked) {
    ctx.notes.push('the rooms could not be read; no Moa-era bots were removed');
    return;
  }
  const removed = new Set(
    candidates.map((b) => (b as { id?: unknown }).id).filter((id): id is string => typeof id === 'string' && !talked.has(id)),
  );
  if (removed.size === 0) return;

  const backup = `${botsFile}.premigrate`;
  if (!fs.existsSync(backup)) fs.copyFileSync(botsFile, backup);
  const usage = current.usage && typeof current.usage === 'object' && !Array.isArray(current.usage)
    ? { ...(current.usage as Record<string, unknown>) }
    : current.usage;
  if (usage && typeof usage === 'object') for (const id of removed) delete (usage as Record<string, unknown>)[id];
  atomicWriteJSONSync(botsFile, {
    ...current,
    bots: current.bots.filter((b) => !removed.has((b as { id?: unknown })?.id as string)),
    ...(usage !== undefined ? { usage } : {}),
  });

  const settingsFile = factorySettingsPath(ctx.wmuxDir);
  try {
    if (fs.existsSync(settingsFile)) {
      const s = atomicReadJSONSync<unknown>(settingsFile);
      if (s && typeof s === 'object' && !Array.isArray(s) && removed.has((s as { phoneBotId?: unknown }).phoneBotId as string)) {
        const next = { ...(s as Record<string, unknown>) };
        delete next.phoneBotId;
        atomicWriteJSONSync(settingsFile, next);
      }
    }
  } catch {
    // A pin naming no bot is ignored anyway (phoneBot.ts).
  }
  ctx.notes.push(`removed ${removed.size} Moa-era bot(s) the owner never talked to (backup: bots.json.premigrate)`);
}
