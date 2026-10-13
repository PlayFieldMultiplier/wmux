// Owner approvals — the main window's side (shared/botApproval.ts
// BOT_APPROVAL_IPC). Only the main window's top frame is served: these
// channels are where the owner decides (the approval card's buttons, the
// composer's "Approve N pending" chip, Settings › Bots' rules list). Any
// other sender is refused before anything is read or written. The decisions
// themselves are the approval store's (factory/approvals.ts); nothing here
// adds a way to decide that the store does not check.
import { ipcMain, type BrowserWindow } from 'electron';
import { BOT_APPROVAL_IPC, type ApprovalRule } from '../../../shared/botApproval';
import { getApprovalService, type ApprovalService, type ApprovalView } from '../../factory/approvals';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';

const NOT_OPERATOR = { ok: false, code: 'operator_only', message: 'only the main window decides approvals' } as const;
const NOT_STARTED = { ok: false, code: 'not_started', message: 'approvals are not running' } as const;

export type ApprovalListResponse = { ok: true; requests: ApprovalView[] } | { ok: false; code: string; message: string };
export type ApprovalRulesResponse = { ok: true; rules: ApprovalRule[] } | { ok: false; code: string; message: string };
export type ApprovalDecideResponse = ReturnType<ApprovalService['decide']> | typeof NOT_OPERATOR | typeof NOT_STARTED;

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function registerApprovalIpcHandlers(
  getWindow: () => BrowserWindow | null,
  service: () => ApprovalService | null = getApprovalService,
): () => void {
  const channels = Object.values(BOT_APPROVAL_IPC);
  for (const c of channels) ipcMain.removeHandler(c);
  const operatorOnly = <R>(fn: (raw: unknown, s: ApprovalService) => R) =>
    (e: Electron.IpcMainInvokeEvent, raw: unknown): R | typeof NOT_OPERATOR | typeof NOT_STARTED => {
      if (!isMainWindowSender(e, getWindow())) return NOT_OPERATOR;
      const s = service();
      return s ? fn(raw, s) : NOT_STARTED;
    };
  ipcMain.handle(BOT_APPROVAL_IPC.list, wrapHandler(BOT_APPROVAL_IPC.list, operatorOnly((raw, s): ApprovalListResponse => {
    const ws = obj(raw).workspaceId;
    return { ok: true, requests: s.listForOperator(typeof ws === 'string' && ws ? ws : undefined) };
  })));
  ipcMain.handle(BOT_APPROVAL_IPC.decide, wrapHandler(BOT_APPROVAL_IPC.decide, operatorOnly((raw, s) => s.decide(obj(raw), 'desktop'))));
  ipcMain.handle(BOT_APPROVAL_IPC.rules, wrapHandler(BOT_APPROVAL_IPC.rules, operatorOnly((_raw, s): ApprovalRulesResponse => ({ ok: true, rules: s.rulesList() }))));
  ipcMain.handle(BOT_APPROVAL_IPC.revokeRule, wrapHandler(BOT_APPROVAL_IPC.revokeRule, operatorOnly((raw, s) => s.revokeRule(obj(raw).ruleId))));
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
