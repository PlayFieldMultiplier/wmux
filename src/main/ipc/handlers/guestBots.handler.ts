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
} from '../../../shared/guestBots';
import { getRoomWriter } from '../../factory/roomWriter';

const CODES: readonly GuestBotErrorCode[] = ['unavailable', 'invalid', 'too-many', 'not-found', 'persist-failed'];

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

export async function listGuestBots(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null): Promise<GuestBotListResult> {
  if (!dc || !dc.isConnected) return { ok: false, code: 'unavailable' };
  try {
    const res = (await dc.rpc(GUEST_BOT_RPC.list as never, {})) as Record<string, unknown> | null;
    if (!res || res.ok !== true || !Array.isArray(res.guests) || !res.gates || typeof res.gates !== 'object') return { ok: false, code: code(res) };
    const guests = res.guests.map(view);
    // All or nothing: a roster missing a live guest would hide one the owner cannot then revoke.
    if (guests.some((g) => g === null)) return { ok: false, code: 'unavailable' };
    const g = res.gates as Record<string, unknown>;
    return {
      ok: true,
      guests: guests as GuestBotView[],
      gates: { enabled: bool(g.enabled), serverRunning: bool(g.serverRunning), transcript: bool(g.transcript), input: bool(g.input), secureTransport: bool(g.secureTransport) },
    };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** `joinSeq`: the conversation's last card seq now (null when the room
 *  cannot say): the guest reads only cards after it. */
export async function createGuestBot(dc: Pick<DaemonClient, 'rpc' | 'isConnected'> | null, req: unknown, joinSeq: (scope: GuestScope) => number | null = () => null): Promise<GuestBotCreateResult> {
  const r = req && typeof req === 'object' ? (req as Record<string, unknown>) : {};
  const name = sanitizeGuestName(r.name);
  const scope = parseGuestScope(r.scope);
  if (!name || !scope) return { ok: false, code: 'invalid' };
  if (!dc || !dc.isConnected) return { ok: false, code: 'unavailable' };
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
    return isGuestId(guestId) ? simple(getDaemonClient(), GUEST_BOT_RPC.revoke, { guestId }) : Promise.resolve({ ok: false as const, code: 'invalid' as const });
  })));
  ipcMain.handle(GUEST_BOT_IPC.setEnabled, wrapHandler(GUEST_BOT_IPC.setEnabled, guard((req) => {
    const enabled = req && typeof req === 'object' ? (req as { enabled?: unknown }).enabled : undefined;
    return typeof enabled === 'boolean' ? simple(getDaemonClient(), GUEST_BOT_RPC.setEnabled, { enabled }) : Promise.resolve({ ok: false as const, code: 'invalid' as const });
  })));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
