/**
 * IPC registration for the first-run wizard (T4).
 *
 * Mirrors the cleanup-function pattern used by other handler modules
 * (see `src/main/ipc/handlers/pty.handler.ts`, `mcp.handler.ts`) so the
 * caller can tear down handlers on renderer reload / process restart.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import { IPC } from '../../shared/constants';
import { wrapHandler } from '../ipc/wrapHandler';
import type { FirstRunOrchestrator } from './FirstRunOrchestrator';
import type { FirstBotResult, SampleTaskStartPayload } from '../../shared/firstRun';
import { AGENT_IDS, type AgentId } from '../../shared/agentSetup';
import type { FactorySettings } from '../../shared/factorySettings';
import { isMainWindowSender } from '../ipc/mainWindowSender';
import { getBotStore } from '../factory/botStore';
import { getFactorySettingsStore } from '../factory/factorySettings';
import { checkFirstRunFolder, firstRunBot } from './firstBot';

function requireAgentId(value: unknown): AgentId {
  if (typeof value !== 'string' || !(AGENT_IDS as readonly string[]).includes(value)) {
    throw new Error('first-run: unknown agent');
  }
  return value as AgentId;
}

/** firstRun:first-bot's body: the sender check, then the first-run bot. */
export function firstBotHandler(
  getWindow: () => BrowserWindow | null,
  deps: { store?: typeof getBotStore; settings?: () => FactorySettings | null } = {},
): (e: { sender?: unknown; senderFrame?: unknown }, req: unknown) => Promise<FirstBotResult> {
  return async (e, req) => {
    if (!isMainWindowSender(e, getWindow())) return { ok: false, code: 'invalid_argument', message: 'only the main window may make the first bot' };
    const settings = deps.settings ? deps.settings() : getFactorySettingsStore()?.get() ?? null;
    return firstRunBot((deps.store ?? getBotStore)(), settings, req);
  };
}

export function registerFirstRunHandlers(orchestrator: FirstRunOrchestrator, getWindow: () => BrowserWindow | null): () => void {
  ipcMain.removeHandler(IPC.FIRST_RUN_CHECK);
  ipcMain.handle(
    IPC.FIRST_RUN_CHECK,
    wrapHandler(IPC.FIRST_RUN_CHECK, async () => orchestrator.check()),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_COMPLETE);
  ipcMain.handle(
    IPC.FIRST_RUN_COMPLETE,
    wrapHandler(IPC.FIRST_RUN_COMPLETE, async () => {
      await orchestrator.complete();
    }),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_DISMISS);
  ipcMain.handle(
    IPC.FIRST_RUN_DISMISS,
    wrapHandler(IPC.FIRST_RUN_DISMISS, async () => {
      await orchestrator.dismiss();
    }),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_REOPEN);
  ipcMain.handle(
    IPC.FIRST_RUN_REOPEN,
    wrapHandler(IPC.FIRST_RUN_REOPEN, async () => orchestrator.reopen()),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_STATUS);
  ipcMain.handle(
    IPC.FIRST_RUN_AGENT_STATUS,
    wrapHandler(IPC.FIRST_RUN_AGENT_STATUS, async () => orchestrator.agentStatus()),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_PLAN);
  ipcMain.handle(
    IPC.FIRST_RUN_AGENT_PLAN,
    wrapHandler(IPC.FIRST_RUN_AGENT_PLAN, async (_event: IpcMainInvokeEvent, agent: unknown, paneShell: unknown) =>
      orchestrator.agentPlan(
        requireAgentId(agent),
        typeof paneShell === 'string' && paneShell.length <= 4096 ? paneShell : undefined,
      )),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_SET_PATH);
  ipcMain.handle(
    IPC.FIRST_RUN_AGENT_SET_PATH,
    wrapHandler(IPC.FIRST_RUN_AGENT_SET_PATH, async (_event: IpcMainInvokeEvent, agent: unknown, input: unknown) => {
      if (input !== null && (typeof input !== 'string' || input.length > 4096)) {
        throw new Error('FIRST_RUN_AGENT_SET_PATH: invalid path');
      }
      return orchestrator.setAgentPath(requireAgentId(agent), input);
    }),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_REGISTER_MCP);
  ipcMain.handle(
    IPC.FIRST_RUN_REGISTER_MCP,
    wrapHandler(IPC.FIRST_RUN_REGISTER_MCP, async () => orchestrator.registerMcp()),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_START_SAMPLE_TASK);
  ipcMain.handle(
    IPC.FIRST_RUN_START_SAMPLE_TASK,
    wrapHandler(
      IPC.FIRST_RUN_START_SAMPLE_TASK,
      async (_event: IpcMainInvokeEvent, payload: SampleTaskStartPayload) => {
        if (!payload || typeof payload.ptyId !== 'string' || payload.ptyId.length === 0) {
          throw new Error('FIRST_RUN_START_SAMPLE_TASK: missing or invalid ptyId');
        }
        // The invoke awaits the runner, but success and the fallback are
        // reported on the FIRST_RUN_SAMPLE_TASK_READY / TIMEOUT event
        // channels, which the wizard subscribed to before it called this.
        //
        // I6 fix: if startSampleTask itself throws (e.g. PTYBridge gone,
        // daemon disconnect mid-flight), the wizard would otherwise hang in
        // 'awaiting-prompt' forever because it relies on the READY/TIMEOUT
        // event channels for resolution. Surface failures as a TIMEOUT
        // event so the wizard's fallback "Press Enter" UI engages.
        //
        // A command that never reached the pane is the one outcome the invoke
        // answers itself: it rejects, so the wizard shows an error instead of
        // success or "press Enter" over an empty prompt.
        const outcome = await orchestrator.startSampleTask(payload.ptyId).catch((err: unknown) => {
          console.error('[firstRun] startSampleTask failed:', err);
          orchestrator.emitSampleTaskTimeout();
          return 'timeout' as const;
        });
        if (outcome === 'undelivered') {
          throw new Error('FIRST_RUN_START_SAMPLE_TASK: the sample command did not reach the pane');
        }
      },
    ),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_CHECK_FOLDER);
  ipcMain.handle(
    IPC.FIRST_RUN_CHECK_FOLDER,
    wrapHandler(IPC.FIRST_RUN_CHECK_FOLDER, async (_event: IpcMainInvokeEvent, folder: unknown) => checkFirstRunFolder(folder)),
  );

  ipcMain.removeHandler(IPC.FIRST_RUN_FIRST_BOT);
  ipcMain.handle(IPC.FIRST_RUN_FIRST_BOT, wrapHandler(IPC.FIRST_RUN_FIRST_BOT, firstBotHandler(getWindow)));

  return () => {
    ipcMain.removeHandler(IPC.FIRST_RUN_CHECK);
    ipcMain.removeHandler(IPC.FIRST_RUN_CHECK_FOLDER);
    ipcMain.removeHandler(IPC.FIRST_RUN_FIRST_BOT);
    ipcMain.removeHandler(IPC.FIRST_RUN_COMPLETE);
    ipcMain.removeHandler(IPC.FIRST_RUN_DISMISS);
    ipcMain.removeHandler(IPC.FIRST_RUN_REOPEN);
    ipcMain.removeHandler(IPC.FIRST_RUN_REGISTER_MCP);
    ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_STATUS);
    ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_PLAN);
    ipcMain.removeHandler(IPC.FIRST_RUN_AGENT_SET_PATH);
    ipcMain.removeHandler(IPC.FIRST_RUN_START_SAMPLE_TASK);
  };
}
