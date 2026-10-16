// skill.* — a bot's own skills (shared/botSkill.ts BOT_SKILL_RPC), and the
// owner's view of them (BOT_SKILL_IPC), registered as the `skills` factory
// module (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   skill.propose  a bot, for itself only (the binding names it), during a
//                  wake: the store writes a proposed version and the
//                  approval store posts its `skill` card with the diff. A
//                  proposal that gets no card is dropped again.
//   skill.read     a bot: one of its own approved skills.
//   IPC list / archive   the main window only.
// Anyone else is refused. Before the module started every method answers
// `not_started`.
//
// The approval store reaches the skills through skillApprovalHost: the
// owner's Approve moves the proposal on the card into place, Deny (or a card
// left unanswered) archives it. A worker a bot starts gets the approved
// skills through installBotSkillsInWorktree (worktask/FanOutService).

import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_EVENT, type BotEventPayload } from '../../../shared/bot';
import { BOT_SKILL_IPC, BOT_SKILL_RPC } from '../../../shared/botSkill';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import { BotSkillStore, getBotSkillStore, installWorkerSkills, setBotSkillStore } from '../../factory/botSkills';
import { getApprovalService, type ApprovalService, type ApprovalSkillHost } from '../../factory/approvals';
import { isMainWindowSender } from '../../ipc/mainWindowSender';

type Refusal = { ok: false; code: 'not_bot' | 'not_started' | 'invalid'; message: string };

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = refuse('not_started', 'skills are not running yet');

export interface SkillHandlerDeps {
  store: () => BotSkillStore | null;
  approvals: () => Pick<ApprovalService, 'proposeSkill' | 'withdraw' | 'get'> | null;
  emit: (payload: BotEventPayload) => void;
}

export function registerSkillHandlers(router: Pick<FactoryRouter, 'register'>, deps: SkillHandlerDeps): void {
  router.register(BOT_SKILL_RPC.propose, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_bot', 'a bot proposes its own skills');
    const store = deps.store();
    const approvals = deps.approvals();
    if (!store || !approvals) return NOT_STARTED;
    const bot = ctx.bot;
    const p = obj(raw);
    const res = store.propose(bot.botId, { name: p.name, content: p.content, references: p.references, reason: p.reason });
    if (!res.ok) return res;
    // The same proposal with its card still open: that one.
    if (res.duplicate && res.approvalId && approvals.get(res.approvalId)?.state === 'pending') {
      return { ok: true, duplicate: true, skill: res.skill, approvalId: res.approvalId, message: 'This proposal already waits for the owner.' };
    }
    const req = approvals.proposeSkill(bot, {
      name: res.skill.name, hash: res.hash, version: res.version, update: res.update, diff: res.diff,
      reason: typeof p.reason === 'string' ? p.reason : '',
    });
    if (!req.ok) {
      store.discardProposal(bot.botId, res.skill.name, res.hash);
      deps.emit({ type: 'skills-changed', botId: bot.botId });
      return req;
    }
    if (res.replacedApprovalId) approvals.withdraw(res.replacedApprovalId);
    store.attachApproval(bot.botId, res.skill.name, res.hash, req.request.requestId);
    deps.emit({ type: 'skills-changed', botId: bot.botId });
    const skill = store.list(bot.botId).find((s) => s.name === res.skill.name) ?? res.skill;
    return {
      ok: true, skill, approvalId: req.request.requestId,
      message: 'Proposed. The owner\'s approval card shows the change; nothing loads until they approve it.',
    };
  });

  router.register(BOT_SKILL_RPC.read, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_bot', 'a bot reads its own skills');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const p = obj(raw);
    return store.read(ctx.bot.botId, p.name, p.reference);
  });
}

/** What the approval store's `skill` decisions do. */
export function skillApprovalHost(store: () => BotSkillStore | null, emit: (payload: BotEventPayload) => void): ApprovalSkillHost {
  return {
    approve(r) {
      const s = store();
      if (!s) return 'skills are not running';
      if (!r.skill) return 'the request names no skill';
      const res = s.approve(r.botId, r.skill.name, r.skill.hash);
      emit({ type: 'skills-changed', botId: r.botId });
      return res.ok ? null : res.message;
    },
    deny(r) {
      const s = store();
      if (!s || !r.skill) return;
      s.deny(r.botId, r.skill.name, r.skill.hash);
      emit({ type: 'skills-changed', botId: r.botId });
    },
  };
}

let approvalHost: ApprovalSkillHost | null = null;

/** The host the approval store calls, once the module started. */
export function getSkillApprovalHost(): ApprovalSkillHost | null {
  return approvalHost;
}

/** The owner's list and Archive, for the main window. Never throws. */
export function registerSkillIpc(getWindow: () => BrowserWindow | null, deps: SkillHandlerDeps): () => void {
  const channels = Object.values(BOT_SKILL_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const denied = { ok: false, error: 'only the wmux window may do this' } as const;
  ipcMain.handle(BOT_SKILL_IPC.list, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const store = deps.store();
    if (!store) return { ok: false, error: 'skills are not running yet' };
    const botId = obj(req).botId;
    if (typeof botId !== 'string') return { ok: false, error: 'botId is required' };
    return { ok: true, skills: store.list(botId) };
  });
  ipcMain.handle(BOT_SKILL_IPC.archive, async (e, req: unknown) => {
    if (!isMainWindowSender(e, getWindow())) return denied;
    const store = deps.store();
    if (!store) return { ok: false, error: 'skills are not running yet' };
    const p = obj(req);
    if (typeof p.botId !== 'string') return { ok: false, error: 'botId is required' };
    try {
      const res = store.archive(p.botId, p.name);
      if (!res.ok) return { ok: false, error: res.message };
      if (res.approvalId) deps.approvals()?.withdraw(res.approvalId);
      deps.emit({ type: 'skills-changed', botId: p.botId });
      return { ok: true, skill: res.skill };
    } catch {
      return { ok: false, error: 'The request failed.' };
    }
  });
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

/** A worker a bot starts: its approved skills, copied into the worktree and
 *  excluded from git. Best effort — a failure is logged and the worker
 *  starts without them. */
export async function installBotSkillsInWorktree(botId: string, worktree: string): Promise<void> {
  const store = getBotSkillStore();
  if (!store) return;
  try {
    const skills = store.approved(botId);
    if (skills.length === 0) return;
    const [{ git }, { excludeLineOnce }] = await Promise.all([import('../../git/git'), import('../../git/infoExclude')]);
    const copied = await installWorkerSkills(skills, worktree, { git, exclude: excludeLineOnce });
    if (copied.length > 0) console.log(`[factory] skills: ${copied.length} copied into ${path.basename(worktree)}`);
  } catch (err) {
    console.warn(`[factory] skills not copied into ${path.basename(worktree)}: ${String(err)}`);
  }
}

export function createSkillModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>): FactoryModuleHandle {
  let offIpc: (() => void) | null = null;
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  return {
    start() {
      if (getBotSkillStore()) return;
      setBotSkillStore(new BotSkillStore({ wmuxDir: deps.wmuxDir() }));
      approvalHost = skillApprovalHost(getBotSkillStore, emit);
      offIpc = registerSkillIpc(deps.getMainWindow, { store: getBotSkillStore, approvals: getApprovalService, emit });
    },
    dispose() {
      offIpc?.();
      offIpc = null;
      approvalHost = null;
      setBotSkillStore(null);
    },
  };
}

registerFactoryRpcModule('skills', (router, deps) => {
  const emit = (payload: BotEventPayload): void => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
  };
  registerSkillHandlers(router, { store: getBotSkillStore, approvals: getApprovalService, emit });
  return createSkillModule(deps);
});
