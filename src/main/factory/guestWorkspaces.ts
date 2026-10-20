// ─── Guest workspaces — `<wmuxDir>/factory/guest-workspaces.json` ──────────
//
// A guest workspace is an island: external guest bots (shared/guestBots.ts)
// join conversations of a guest workspace only, every wake of a bot in one
// is a guest wake (wakeTaint.ts wakeGuest), and nothing crosses between a
// guest workspace and any other workspace except the owner's own actions in
// the window. This file is the one predicate every chokepoint asks.
//
// The flag is add-only: `markGuestWorkspace` (guestBots.handler.ts) is its
// only writer and nothing clears it, revoking every guest included. It lives
// in its own versioned file, so a factory settings patch cannot touch it.
//
// Three states. `guestWorkspaceFlag(ws)` is the file's flag: true, false, or
// 'unknown' while the store is not loaded or its file could not be read (a
// malformed file is never dropped or overwritten). `isGuestWorkspace(ws)` is
// the union the rest of main reads: the flag, the rooms that held a guest
// card when the store loaded, and the workspaces of the daemon's guest
// records (revoked ones included) main has seen. Readers:
//   - guest ingress (a guest's read or post, a guest create) needs the flag
//     to be true: a guest whose workspace was never flagged reaches nothing;
//   - every other check treats 'unknown' as guest (guestSide), so a store
//     that cannot say keeps the clean side closed.
//
// Where no store is expected (a router or a bot store built alone, in
// tests), a workspace is clean; where one is (expectGuestWorkspaces, called
// by the bot runtime module), a missing store is 'unknown'.

import fs from 'node:fs';
import path from 'node:path';
import { botEngineGatesTools, botTemplate, type BotProfile } from '../../shared/bot';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import type { GuestProvenance } from './wakeTaint';

export const GUEST_WORKSPACES_FILENAME = 'guest-workspaces.json';
export const GUEST_WORKSPACES_VERSION = 1 as const;

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function guestWorkspacesPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', GUEST_WORKSPACES_FILENAME);
}

/** One flagged workspace as the owner's surfaces list it. */
export interface GuestWorkspaceEntry {
  workspaceId: string;
  /** When it was flagged (ISO). */
  since: string;
}

export interface GuestWorkspaceStoreOptions {
  file: string;
  /** The rooms directory (`factory/rooms`), scanned once on load for rooms
   *  that already hold a guest card. Absent: not scanned. */
  roomsDir?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class GuestWorkspaceStore {
  private flags = new Map<string, string>();
  private readonly guestRooms = new Set<string>();
  private state: 'unloaded' | 'loaded' | 'unreadable' = 'unloaded';
  /** The file itself could not be read and its backup was: a flag from the
   *  last write may be missing. */
  private restored = false;
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: GuestWorkspaceStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[factory] ${m}`));
    this.persister = createFilePersister(opts.file, () => ({ version: GUEST_WORKSPACES_VERSION, workspaces: Object.fromEntries([...this.flags].map(([ws, since]) => [ws, { since }])) }));
  }

  /** Read the file (missing → none flagged). A file that cannot be read,
   *  carries another version or holds a malformed entry leaves the store
   *  unreadable: every flag reads 'unknown' and nothing is written. Never
   *  throws. */
  load(): void {
    this.flags = new Map();
    this.restored = false;
    try {
      const own = this.primaryReadable();
      const raw = readVersionedFile(this.opts.file, GUEST_WORKSPACES_VERSION);
      // The atomic reader falls back to the last write's backup: said, so
      // the owner can check the list (the backup's flags hold meanwhile).
      if (raw && !own) {
        this.restored = true;
        this.log(`${this.opts.file} could not be read; its backup was used, so a workspace flagged last may be missing`);
      }
      if (raw) {
        const ws = raw.workspaces;
        if (!ws || typeof ws !== 'object' || Array.isArray(ws)) throw new Error('workspaces is not an object');
        for (const [id, v] of Object.entries(ws as Record<string, unknown>)) {
          const since = v && typeof v === 'object' ? (v as { since?: unknown }).since : undefined;
          if (!WORKSPACE_ID_RE.test(id) || typeof since !== 'string' || Number.isNaN(Date.parse(since))) throw new Error(`entry ${id} is malformed`);
          this.flags.set(id, since);
        }
      }
      this.state = 'loaded';
    } catch (err) {
      this.flags = new Map();
      this.state = 'unreadable';
      this.log(`${this.opts.file} is unreadable; every workspace counts as a guest workspace until it is fixed: ${String(err)}`);
    }
    this.scanRooms();
  }

  /** Whether the file itself (not its backup) parses as this version. */
  private primaryReadable(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as unknown;
      return !!raw && typeof raw === 'object' && (raw as { version?: unknown }).version === GUEST_WORKSPACES_VERSION;
    } catch {
      return false;
    }
  }

  /** The list was read from the backup of its last write (see load). */
  restoredFromBackup(): boolean {
    return this.restored;
  }

  /** The rooms that already hold a guest card (written before the flag
   *  existed). Read once; a room that cannot be read is skipped. */
  private scanRooms(): void {
    const dir = this.opts.roomsDir;
    if (!dir) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const name of names) {
      const ws = name.slice(0, -'.jsonl'.length);
      if (!WORKSPACE_ID_RE.test(ws)) continue;
      try {
        // A card is one JSON line; a quoted value inside another string is
        // escaped, so this matches a card's own kind only.
        if (fs.readFileSync(path.join(dir, name), 'utf8').includes('"kind":"guest"')) this.guestRooms.add(ws);
      } catch {
        /* unreadable: the room store reports it */
      }
    }
  }

  /** The file's flag for `ws`. */
  flag(workspaceId: string): GuestProvenance {
    if (this.state !== 'loaded') return 'unknown';
    return this.flags.has(workspaceId);
  }

  /** The union (see the header). */
  isGuest(workspaceId: string, recordScopes: ReadonlySet<string>): GuestProvenance {
    if (this.flags.has(workspaceId) || this.guestRooms.has(workspaceId) || recordScopes.has(workspaceId)) return true;
    return this.state === 'loaded' ? false : 'unknown';
  }

  /** The flagged workspaces, oldest first ([] when the file is unreadable). */
  list(): GuestWorkspaceEntry[] {
    return [...this.flags].map(([workspaceId, since]) => ({ workspaceId, since })).sort((a, b) => a.since.localeCompare(b.since));
  }

  /** Whether the file could be read. */
  readable(): boolean {
    return this.state === 'loaded';
  }

  /** Flag `ws` and resolve once it is on disk. Throws when the store is not
   *  loaded or its file is unreadable (never overwritten), or when the write
   *  fails; a flag that is not on disk stays flagged in memory. */
  async add(workspaceId: string): Promise<void> {
    if (this.state !== 'loaded') throw new Error('the guest workspace list could not be read');
    if (!WORKSPACE_ID_RE.test(workspaceId)) throw new Error('not a workspace id');
    if (!this.flags.has(workspaceId)) this.flags.set(workspaceId, new Date(this.now()).toISOString());
    await this.persister.schedule();
  }

  /** Resolves once every write so far has finished. */
  flush(): Promise<void> {
    return this.persister.schedule();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let current: GuestWorkspaceStore | null = null;
let expected = false;
/** Workspaces of the daemon's guest records main has seen (listGuestBots,
 *  createGuestBot). Kept across store restarts; only grows. */
const recordScopes = new Set<string>();

/** The bot runtime module is part of the app: until its store runs, every
 *  workspace is 'unknown'. */
export function expectGuestWorkspaces(on = true): void {
  expected = on;
}

/** Set by the bot runtime module's start(). */
export function setGuestWorkspaceStore(store: GuestWorkspaceStore | null): void {
  current = store;
}

export function getGuestWorkspaceStore(): GuestWorkspaceStore | null {
  return current;
}

/** Record the workspaces of the daemon's guest records (revoked included). */
export function noteGuestRecordWorkspaces(workspaceIds: Iterable<string>): void {
  for (const ws of workspaceIds) if (typeof ws === 'string' && WORKSPACE_ID_RE.test(ws)) recordScopes.add(ws);
}

/** Test-only. */
export function __resetGuestWorkspacesForTesting(): void {
  current = null;
  expected = false;
  recordScopes.clear();
}

/** The file's flag: what guest ingress requires to be true. */
export function guestWorkspaceFlag(workspaceId: string): GuestProvenance {
  if (!current) return expected ? 'unknown' : false;
  return current.flag(workspaceId);
}

/** Whether `ws` is a guest workspace, by the union (see the header). */
export function isGuestWorkspace(workspaceId: string): GuestProvenance {
  if (!current) {
    if (recordScopes.has(workspaceId)) return true;
    return expected ? 'unknown' : false;
  }
  return current.isGuest(workspaceId, recordScopes);
}

/** Whether a clean-side check must treat `ws` as a guest workspace: one, or
 *  one that cannot be told. */
export function guestSide(workspaceId: string | null | undefined): boolean {
  if (typeof workspaceId !== 'string') return false;
  return isGuestWorkspace(workspaceId) !== false;
}

/** The boundary rule: two workspaces may exchange anything only when they
 *  are the same one, or when neither is a guest workspace. */
export function crossesGuestBoundary(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return false;
  return guestSide(a) || guestSide(b);
}

/** Whether a bot of `botWorkspaceId` may see a fact, by the island alone: a
 *  bot in a guest workspace sees only its own workspace's facts (none
 *  without a workspace, none of a repository), and no other bot sees a
 *  guest workspace's. */
export function factInIsland(botWorkspaceId: string, fact: { workspaceId?: string }): boolean {
  if (guestSide(botWorkspaceId)) return fact.workspaceId === botWorkspaceId;
  return fact.workspaceId === undefined || !guestSide(fact.workspaceId);
}

// ── Construction rules ─────────────────────────────────────────────────────

/** Every rule a bot breaks to be in a guest workspace as it is: a guest
 *  workspace holds no repository, no Coordinator, only bots of the `lead`
 *  role (the others' default triggers reach across workspaces) and only
 *  engines that hold their tools back per call. Pure. */
export function guestWorkspaceBotRefusals(bot: Pick<BotProfile, 'role' | 'template' | 'engine' | 'repo'>): string[] {
  const out: string[] = [];
  const template = botTemplate(bot);
  if (bot.repo) out.push('a bot in a guest workspace has no repository');
  if (template === 'coordinator' || bot.role === 'moa') out.push('a guest workspace has no Coordinator');
  else if (bot.role !== 'lead' || template === 'reviewer' || template === 'issue') out.push('a bot in a guest workspace is a Developer, Researcher or Custom bot');
  if (!botEngineGatesTools(bot.engine)) out.push('a bot in a guest workspace runs on an engine that holds its tools back for guest messages (Claude SDK)');
  return out;
}

/** The first rule a bot breaks to be in a guest workspace, or null. Pure. */
export function guestWorkspaceBotRefusal(bot: Pick<BotProfile, 'role' | 'template' | 'engine' | 'repo'>): string | null {
  return guestWorkspaceBotRefusals(bot)[0] ?? null;
}
