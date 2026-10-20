// The owner's guest bots (shared/guestBots.ts), from the Bots page to the
// daemon that holds them. Main-window top frame only. Every call resolves
// (never rejects); a token comes back only from `create`, once, and is never
// logged here.
import { ipcMain, type BrowserWindow } from 'electron';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import { isMainWindowSender } from '../mainWindowSender';
import {
  GUEST_BOT_IPC, GUEST_BOT_RPC, isGuestId, parseGuestScope, sanitizeGuestName,
  type GuestBotCreateResult, type GuestBotErrorCode, type GuestBotListResult, type GuestBotSimpleResult, type GuestBotView, type GuestScope,
  type GuestWorkspaceList, type GuestWorkspaceMarkResult,
} from '../../../shared/guestBots';
import { isPhoneRoomWorkspaceId } from '../../../shared/phoneRooms';
import type { BotProfile } from '../../../shared/bot';
import { getRoomWriter } from '../../factory/roomWriter';
import { dropQueuedGuestWakes } from '../../factory/wakeQueue';
import { getGuestWorkspaceStore, guestWorkspaceBotRefusal, guestWorkspaceFlag, noteGuestRecordWorkspaces } from '../../factory/guestWorkspaces';
import type { GuestProvenance } from '../../factory/wakeTaint';
import { getBotStore } from '../../factory/botStore';
import { getFactorySettings } from '../../factory/factorySettings';
import { getBotRuntime } from '../../factory/BotRuntime';
import { openBotWorkers } from '../../factory/openBotWorkers';
import { getTaskLedger } from '../../deck/taskLedgerHost';

const CODES: readonly GuestBotErrorCode[] = ['unavailable', 'invalid', 'too-many', 'not-found', 'persist-failed', 'not-guest-workspace'];

/** The guest workspaces as this handler reads and writes them
 *  (main/factory/guestWorkspaces.ts). */
export interface GuestWorkspacePorts {
  /** The file's flag: a guest is made only where it is true. */
  flag(workspaceId: string): GuestProvenance;
  list(): GuestWorkspaceList;
  /** Resolves once the flags are on disk; rejects when they cannot be. */
  flush(): Promise<void>;
  /** The one writer of a flag (markGuestWorkspace). */
  add(workspaceId: string): Promise<void>;
  hqWorkspaceId(): string | null;
  /** The workspace's bots; null before the bot store started. */
  bots(workspaceId: string): BotProfile[] | null;
  /** A turn, a task or a worker of the workspace is running. */
  liveWork(workspaceId: string, bots: readonly BotProfile[]): boolean;
  /** The workspaces of the daemon's guest records. */
  noteRecords(workspaceIds: string[]): void;
}

export function defaultGuestWorkspacePorts(): GuestWorkspacePorts {
  const store = () => getGuestWorkspaceStore();
  return {
    flag: guestWorkspaceFlag,
    list: () => {
      const s = store();
      if (!s || !s.readable()) return { readable: false, workspaceIds: [] };
      return { readable: true, workspaceIds: s.list().map((e) => e.workspaceId), ...(s.restoredFromBackup() ? { restored: true as const } : {}) };
    },
    flush: async () => {
      const s = store();
      if (!s) throw new Error('the guest workspace list is not running');
      await s.flush();
    },
    add: async (ws) => {
      const s = store();
      if (!s) throw new Error('the guest workspace list is not running');
      await s.add(ws);
    },
    hqWorkspaceId: () => getFactorySettings().hqWorkspaceId,
    bots: (ws) => getBotStore()?.list({ workspaceId: ws }) ?? null,
    liveWork: (ws, bots) => {
      const ids = new Set(bots.map((b) => b.id));
      const runtime = getBotRuntime();
      if (bots.some((b) => runtime?.currentTurn(b.id) || openBotWorkers(b.id).bot > 0)) return true;
      return getTaskLedger().list({ openOnly: true }).some((r) => r.taskWorkspaceId === ws || r.ownerWorkspaceId === ws
        || (r.dispatch?.origin?.kind === 'bot' && ids.has(r.dispatch.origin.botId ?? '')));
    },
    noteRecords: noteGuestRecordWorkspaces,
  };
}

function code(raw: unknown): GuestBotErrorCode {
  const c = raw && typeof raw === 'object' ? (raw as { code?: unknown }).code : undefined;
  return typeof c === 'string' && (CODES as readonly string[]).includes(c) ? (c as GuestBotErrorCode) : 'unavailable';
}

function view(raw: unknown): GuestBotView | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const scope = parseGuestScope(g.scope);
  const name = sanitizeGuestName(g.name);
  if (g.v !== 1 || !isGuestId(g.guestId) || !name || !scope || typeof g.createdAt !== 'string') return null;
  const opt = (k: 'lastSeenAt' | 'revokedAt') => (typeof g[k] === 'string' ? { [k]: g[k] as string } : {});
  return { v: 1, guestId: g.guestId, name, scope, createdAt: g.createdAt, ...opt('lastSeenAt'), ...opt('revokedAt') };
}

const bool = (v: unknown): boolean => v === true;

export async function listGuestBots(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null, workspaces: GuestWorkspacePorts = defaultGuestWorkspacePorts()): Promise<GuestBotListResult> {
  if (!dc || !dc.isConnected) return { ok: false, code: 'unavailable' };
  try {
    const res = (await dc.rpc(GUEST_BOT_RPC.list as never, {})) as Record<string, unknown> | null;
    if (!res || res.ok !== true || !Array.isArray(res.guests) || !res.gates || typeof res.gates !== 'object') return { ok: false, code: code(res) };
    const guests = res.guests.map(view);
    // All or nothing: a roster missing a live guest would hide one the owner cannot then revoke.
    if (guests.some((g) => g === null)) return { ok: false, code: 'unavailable' };
    const g = res.gates as Record<string, unknown>;
    // Every record's workspace, revoked ones too, counts as a guest one on
    // the clean side from now on.
    workspaces.noteRecords((guests as GuestBotView[]).map((v) => v.scope.workspaceId));
    return {
      ok: true,
      guests: guests as GuestBotView[],
      gates: { enabled: bool(g.enabled), serverRunning: bool(g.serverRunning), transcript: bool(g.transcript), input: bool(g.input), secureTransport: bool(g.secureTransport) },
      workspaces: workspaces.list(),
    };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** `joinSeq`: the conversation's last card seq now (null when the room
 *  cannot say): the guest reads only cards after it. A guest is made only
 *  for a conversation of a guest workspace, and only once that flag is on
 *  disk. */
export async function createGuestBot(
  dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null,
  req: unknown,
  joinSeq: (scope: GuestScope) => number | null = () => null,
  workspaces: GuestWorkspacePorts = defaultGuestWorkspacePorts(),
): Promise<GuestBotCreateResult> {
  const r = req && typeof req === 'object' ? (req as Record<string, unknown>) : {};
  const name = sanitizeGuestName(r.name);
  const scope = parseGuestScope(r.scope);
  if (!name || !scope) return { ok: false, code: 'invalid' };
  if (!dc || !dc.isConnected) return { ok: false, code: 'unavailable' };
  let flagged: GuestProvenance;
  try {
    flagged = workspaces.flag(scope.workspaceId);
  } catch {
    flagged = 'unknown';
  }
  if (flagged === 'unknown') return { ok: false, code: 'unavailable' };
  if (flagged !== true) return { ok: false, code: 'not-guest-workspace' };
  try {
    await workspaces.flush();
  } catch {
    return { ok: false, code: 'persist-failed' };
  }
  try {
    let seq: number | null = null;
    try {
      seq = joinSeq(scope);
    } catch {
      seq = null;
    }
    const res = (await dc.rpc(GUEST_BOT_RPC.create as never, { name, scope, ...(seq !== null ? { joinSeq: seq } : {}) })) as Record<string, unknown> | null;
    const guest = view(res?.guest);
    if (!res || res.ok !== true || !guest || typeof res.token !== 'string') return { ok: false, code: code(res) };
    workspaces.noteRecords([guest.scope.workspaceId]);
    return { ok: true, guest, token: res.token };
  } catch {
    // The daemon may have added it: the list shows it, and its token was never seen, so revoke it.
    return { ok: false, code: 'unavailable' };
  }
}

async function simple(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null, method: string, params: Record<string, unknown>): Promise<GuestBotSimpleResult> {
  if (!dc || !dc.isConnected) return { ok: false, code: 'unavailable' };
  try {
    const res = (await dc.rpc(method as never, params)) as Record<string, unknown> | null;
    return res?.ok === true ? { ok: true } : { ok: false, code: code(res) };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** Revoke a guest; its wakes that have not run are dropped whatever the
 *  daemon answers (the owner asked for it to stop): before the daemon is
 *  asked, so none starts while it answers, and again after, for a wake
 *  queued meanwhile. */
export async function revokeGuestBot(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null, guestId: string, drop: (guestId?: string) => number = dropQueuedGuestWakes): Promise<GuestBotSimpleResult> {
  drop(guestId);
  const r = await simple(dc, GUEST_BOT_RPC.revoke, { guestId });
  drop(guestId);
  return r;
}

/** Turn guest bots on or off; off drops every guest wake that has not run. */
export async function setGuestBotsEnabled(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null, enabled: boolean, drop: (guestId?: string) => number = dropQueuedGuestWakes): Promise<GuestBotSimpleResult> {
  // Off: dropped before the daemon is asked and again after (as for a revoke).
  if (!enabled) drop();
  const r = await simple(dc, GUEST_BOT_RPC.setEnabled, { enabled });
  if (!enabled) drop();
  return r;
}

/** Make a workspace a guest workspace: the one writer of the flag, which
 *  never clears. Refused for the HQ workspace, while a bot in it breaks a
 *  guest workspace's rules (guestWorkspaceBotRefusal), and while a turn, a
 *  task or a worker of it runs: what runs now started outside the island. */
export async function markGuestWorkspace(req: unknown, workspaces: GuestWorkspacePorts = defaultGuestWorkspacePorts()): Promise<GuestWorkspaceMarkResult> {
  const ws = req && typeof req === 'object' ? (req as { workspaceId?: unknown }).workspaceId : undefined;
  if (!isPhoneRoomWorkspaceId(ws)) return { ok: false, code: 'invalid' };
  try {
    const flagged = workspaces.flag(ws);
    if (flagged === 'unknown') return { ok: false, code: 'unavailable' };
    if (flagged === true) return { ok: true };
    if (workspaces.hqWorkspaceId() === ws) return { ok: false, code: 'refused', refusal: 'hq' };
    const bots = workspaces.bots(ws);
    if (!bots) return { ok: false, code: 'unavailable' };
    const breaking = bots.filter((b) => guestWorkspaceBotRefusal(b) !== null).map((b) => b.id);
    if (breaking.length > 0) return { ok: false, code: 'refused', refusal: 'bots', botIds: breaking };
    if (workspaces.liveWork(ws, bots)) return { ok: false, code: 'refused', refusal: 'live-work' };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
  try {
    await workspaces.add(ws);
    return { ok: true };
  } catch {
    return { ok: false, code: 'persist-failed' };
  }
}

export function registerGuestBotHandlers(getDaemonClient: () => DaemonClient | null, getWindow: () => BrowserWindow | null): () => void {
  const channels = Object.values(GUEST_BOT_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false as const, code: 'unavailable' as const };
  const guard = <R>(fn: (req: unknown) => Promise<R>) =>
    async (e: Electron.IpcMainInvokeEvent, req: unknown): Promise<R | typeof denied> => (isMainWindowSender(e, getWindow()) ? fn(req) : denied);
  ipcMain.handle(GUEST_BOT_IPC.list, wrapHandler(GUEST_BOT_IPC.list, guard(() => listGuestBots(getDaemonClient()))));
  ipcMain.handle(GUEST_BOT_IPC.create, wrapHandler(GUEST_BOT_IPC.create, guard((req) => createGuestBot(getDaemonClient(), req, (scope) => getRoomWriter()?.summary(scope.workspaceId, scope.threadId).lastSeq ?? null))));
  ipcMain.handle(GUEST_BOT_IPC.revoke, wrapHandler(GUEST_BOT_IPC.revoke, guard((req) => {
    const guestId = req && typeof req === 'object' ? (req as { guestId?: unknown }).guestId : undefined;
    return isGuestId(guestId) ? revokeGuestBot(getDaemonClient(), guestId) : Promise.resolve({ ok: false as const, code: 'invalid' as const });
  })));
  ipcMain.handle(GUEST_BOT_IPC.markWorkspace, wrapHandler(GUEST_BOT_IPC.markWorkspace, guard((req) => markGuestWorkspace(req))));
  ipcMain.handle(GUEST_BOT_IPC.setEnabled, wrapHandler(GUEST_BOT_IPC.setEnabled, guard((req) => {
    const enabled = req && typeof req === 'object' ? (req as { enabled?: unknown }).enabled : undefined;
    return typeof enabled === 'boolean' ? setGuestBotsEnabled(getDaemonClient(), enabled) : Promise.resolve({ ok: false as const, code: 'invalid' as const });
  })));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
