// Owner-only workflow controls. Bot MCP retains read/create/advance only.
import { ipcMain, type BrowserWindow } from 'electron';
import { WORKFLOW_OWNER_IPC, workflowView, type OwnerWorkflowRequest, type OwnerWorkflowReadResult, type OwnerWorkflowCancelResult } from '../../../shared/botWorkflow';
import { getBotWorkflowStore } from '../../factory/botWorkflow';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';

function request(raw: unknown): OwnerWorkflowRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.botId !== 'string' || !r.botId.trim() || r.botId.length > 100
    || typeof r.workspaceId !== 'string' || !r.workspaceId.trim() || r.workspaceId.length > 200
    || (r.workflowId !== undefined && (typeof r.workflowId !== 'string' || !/^wf-[a-f0-9]{24}$/.test(r.workflowId)))) return null;
  return { botId: r.botId, workspaceId: r.workspaceId, ...(typeof r.workflowId === 'string' ? { workflowId: r.workflowId } : {}) };
}

export function workflowOwnerHandlers(getWindow: () => BrowserWindow | null, store = getBotWorkflowStore) {
  return {
    read: async (e: { sender?: unknown; senderFrame?: unknown }, raw: unknown): Promise<OwnerWorkflowReadResult> => {
      if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only' };
      const r = request(raw);
      if (!r) return { ok: false, code: 'invalid_request' };
      const s = store();
      if (!s) return { ok: false, code: 'unavailable' };
      await s.flush();
      if (r.workflowId) {
        const w = s.get(r.workflowId, r.botId, r.workspaceId);
        return w ? { ok: true, workflows: [workflowView(w)] } : { ok: false, code: 'not_found' };
      }
      return { ok: true, workflows: s.list(r.botId, r.workspaceId).map(workflowView) };
    },
    cancel: async (e: { sender?: unknown; senderFrame?: unknown }, raw: unknown): Promise<OwnerWorkflowCancelResult> => {
      if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'operator_only' };
      const r = request(raw);
      const rev = (raw as { expectedRevision?: unknown } | null)?.expectedRevision;
      if (!r?.workflowId || !Number.isSafeInteger(rev) || Number(rev) < 1) return { ok: false, code: 'invalid_request' };
      const s = store();
      if (!s) return { ok: false, code: 'unavailable' };
      const result = await s.cancel(r.workflowId, r.botId, r.workspaceId, Number(rev));
      return result.ok ? { ok: true, workflow: workflowView(result.workflow) } : result;
    },
  };
}

export function registerWorkflowHandlers(getWindow: () => BrowserWindow | null): () => void {
  const handlers = workflowOwnerHandlers(getWindow);
  ipcMain.handle(WORKFLOW_OWNER_IPC.read, wrapHandler(WORKFLOW_OWNER_IPC.read, handlers.read));
  ipcMain.handle(WORKFLOW_OWNER_IPC.cancel, wrapHandler(WORKFLOW_OWNER_IPC.cancel, handlers.cancel));
  return () => {
    ipcMain.removeHandler(WORKFLOW_OWNER_IPC.read);
    ipcMain.removeHandler(WORKFLOW_OWNER_IPC.cancel);
  };
}
