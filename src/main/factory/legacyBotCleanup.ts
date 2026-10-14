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
// one on keeps it). The owner counts as having dealt with it — and it stays —
// when any of these names it:
//   - a `human` card in any room (factory/rooms/*.jsonl) addressed to it
//     (refs.botIds / refs.botId);
//   - a question, plan or proposal card it wrote that was resolved;
//   - the owner's resolution of a card (a human `fact` card with
//     refs.handoffId) whose handoff the bot sent;
//   - a handoff from the owner to it (an answer picked from a question's
//     options, a message) in factory/handoffs.jsonl;
//   - a fact the owner made about it (actor human, ref.botId) in
//     factory/facts*.jsonl;
//   - the phone pin (settings.phoneBotId).
// Rooms and that migration shipped together (4.4.0), and room retention only
// drops cards older than ROOM_LIMITS.RETAIN_DAYS (90), so a card the owner
// wrote cannot have aged out before this step's first run; the card cap
// (ROOM_STORE_LIMITS.MAX_CARDS) can drop old cards sooner, so a room at the
// cap counts as unreadable. When any of these sources cannot be read, nothing
// is removed.
//
// Removing a bot is what the bot store does on remove: the profile and its
// usage go. Before anything is removed, the bots document as read (the copy
// the atomic read recovered when the primary was damaged) is written to
// bots.json.premigrate, unless a readable one is there already. Idempotent:
// a re-run finds nothing left to remove. Any error removes nothing and leaves
// a note; it never stops the factory (migrate.ts).

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { BOT_ID_RE } from '../../shared/bot';
import { BOTS_FILE_VERSION, botsFilePath } from './botStore';
import { ROOM_STORE_LIMITS } from './roomWriter';
import { factorySettingsPath } from './factorySettings';
import { HANDOFFS_FILENAME } from './handoffRouter';
import type { FactoryMigrationContext } from './migrate';

const LEGACY_NAMES: Readonly<Record<string, string>> = { moa: 'Moa', lead: 'Lead' };
/** A bot's cards the owner answers: resolved, the owner dealt with the bot. */
const ANSWERED_KINDS: ReadonlySet<string> = new Set(['question', 'plan', 'proposal']);

const isBotId = (id: unknown): id is string => typeof id === 'string' && BOT_ID_RE.test(id);

/** The JSON objects of a JSONL file, torn lines skipped; null when it exists
 *  but cannot be read. A missing file is empty. */
function readJsonl(file: string): unknown[] | null {
  let text: string;
  try {
    if (!fs.existsSync(file)) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // A torn line names nobody.
    }
  }
  return out;
}

/** The bot ids an owner message in the rooms was addressed to, and the bots
 *  whose question, plan or proposal card was resolved; `handoffIds` collects
 *  the handoffs the owner's resolutions name (resolved to their bots by
 *  botsDealtWith). Null when the rooms folder exists but cannot be read, or
 *  a room is at the card cap (its oldest cards may be gone). */
export function botsTalkedTo(roomsDir: string, maxCards: number = ROOM_STORE_LIMITS.MAX_CARDS, handoffIds: Set<string> = new Set()): Set<string> | null {
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
      if (!line.includes('"human"') && !line.includes('"resolved"')) continue;
      let card: unknown;
      try {
        card = JSON.parse(line);
      } catch {
        continue;
      }
      if (!card || typeof card !== 'object') continue;
      const c = card as { kind?: unknown; state?: unknown; actor?: { kind?: unknown; botId?: unknown }; refs?: { botIds?: unknown; botId?: unknown; handoffId?: unknown } };
      if (c.actor?.kind === 'bot' && c.state === 'resolved' && typeof c.kind === 'string' && ANSWERED_KINDS.has(c.kind)) {
        if (isBotId(c.actor.botId)) out.add(c.actor.botId);
        continue;
      }
      if (c.kind !== 'human' && c.actor?.kind !== 'human') continue;
      if (typeof c.refs?.handoffId === 'string') handoffIds.add(c.refs.handoffId);
      const ids = [...(Array.isArray(c.refs?.botIds) ? c.refs.botIds : []), c.refs?.botId];
      for (const id of ids) if (isBotId(id)) out.add(id);
    }
    if (cardIds.size >= maxCards) return null;
  }
  return out;
}

/** Every bot the owner dealt with (see the header), or null when a source
 *  cannot be read. */
export function botsDealtWith(wmuxDir: string, factoryDir: string): Set<string> | null {
  const handoffIds = new Set<string>();
  const out = botsTalkedTo(path.join(factoryDir, 'rooms'), ROOM_STORE_LIMITS.MAX_CARDS, handoffIds);
  if (!out) return null;
  // Handoffs: the owner's to a bot, and the bots whose handoffs the owner's
  // resolutions name. The last line of an id is its record; any line counts.
  const handoffs = readJsonl(path.join(factoryDir, HANDOFFS_FILENAME));
  if (!handoffs) return null;
  for (const h of handoffs as { id?: unknown; from?: { kind?: unknown; botId?: unknown }; to?: { kind?: unknown; botId?: unknown } }[]) {
    if (h.from?.kind === 'human' && h.to?.kind === 'bot' && isBotId(h.to.botId)) out.add(h.to.botId);
    if (typeof h.id === 'string' && handoffIds.has(h.id) && h.from?.kind === 'bot' && isBotId(h.from.botId)) out.add(h.from.botId);
  }
  // The owner's facts about a bot (its messages, corrections, answers).
  let factFiles: string[];
  try {
    factFiles = fs.existsSync(factoryDir) ? fs.readdirSync(factoryDir).filter((n) => /^facts(\.\d+)?\.jsonl$/.test(n)) : [];
  } catch {
    return null;
  }
  for (const name of factFiles) {
    const facts = readJsonl(path.join(factoryDir, name));
    if (!facts) return null;
    for (const f of facts as { actor?: { kind?: unknown }; ref?: { botId?: unknown } }[]) {
      if (f.actor?.kind === 'human' && isBotId(f.ref?.botId)) out.add(f.ref.botId);
    }
  }
  // The phone pin.
  const settingsFile = factorySettingsPath(wmuxDir);
  if (fs.existsSync(settingsFile)) {
    const s = atomicReadJSONSync<unknown>(settingsFile);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const pin = (s as { phoneBotId?: unknown }).phoneBotId;
    if (isBotId(pin)) out.add(pin);
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
  const talked = botsDealtWith(ctx.wmuxDir, ctx.factoryDir);
  if (!talked) {
    ctx.notes.push('the rooms, handoffs, facts or settings could not be read; no Moa-era bots were removed');
    return;
  }
  const removed = new Set(
    candidates.map((b) => (b as { id?: unknown }).id).filter((id): id is string => typeof id === 'string' && !talked.has(id)),
  );
  if (removed.size === 0) return;

  // The backup is the document as read — a damaged primary is never copied
  // over it — and is written before anything is removed.
  const backup = `${botsFile}.premigrate`;
  let kept: unknown = null;
  try {
    kept = fs.existsSync(backup) ? JSON.parse(fs.readFileSync(backup, 'utf8')) : null;
  } catch {
    kept = null;
  }
  if (!kept || typeof kept !== 'object' || !Array.isArray((kept as { bots?: unknown }).bots)) {
    atomicWriteJSONSync(backup, current, { durable: true });
  }
  const usage = current.usage && typeof current.usage === 'object' && !Array.isArray(current.usage)
    ? { ...(current.usage as Record<string, unknown>) }
    : current.usage;
  if (usage && typeof usage === 'object') for (const id of removed) delete (usage as Record<string, unknown>)[id];
  atomicWriteJSONSync(botsFile, {
    ...current,
    bots: current.bots.filter((b) => !removed.has((b as { id?: unknown })?.id as string)),
    ...(usage !== undefined ? { usage } : {}),
  });

  // The phone pin is never one of them: a pinned bot counts as dealt with.
  ctx.notes.push(`removed ${removed.size} Moa-era bot(s) the owner never talked to (backup: bots.json.premigrate)`);
}
