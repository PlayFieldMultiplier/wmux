// Project config IPC (X5 wmux.json) — thin renderer-facing surface over
// ProjectConfigStore. Both channels are renderer-only (no pipe RPC exposure):
// external MCP clients have no business reading or — far worse — GRANTING
// project trust, so the trust mutation stays behind the first-party IPC
// boundary the same way session.save does.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getProjectConfigStore, type ProjectConfigState } from '../../project/ProjectConfigStore';
import {
  parseWorkspacePrepSettings,
  readWorkspacePrepSettings,
  saveWorkspacePrepSettings,
  type WorkspacePrepSettingsDeps,
} from '../../project/workspacePrepSettings';
import type { WorkspacePrepSaveResult, WorkspacePrepSettingsView } from '../../../shared/workspacePrepSettings';

function prepDeps(): WorkspacePrepSettingsDeps {
  const store = getProjectConfigStore();
  return {
    getState: (cwd) => store.getState(cwd),
    setTrusted: (root, contentHash, unattended) => store.setDecision(root, 'trusted', contentHash, unattended),
    unattendedFor: async (root, contentHash) => {
      const rec = await store.getRecord(root);
      return rec?.status === 'trusted' && rec.contentHash === contentHash && rec.unattended === true;
    },
  };
}

const MAX_PATH_LEN = 4096;

export function registerProjectConfigHandlers(): () => void {
  ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
  ipcMain.handle(IPC.PROJECT_CONFIG_GET, wrapHandler(IPC.PROJECT_CONFIG_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<ProjectConfigState> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) {
      return { found: false };
    }
    return getProjectConfigStore().getState(cwd);
  }));

  ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
  ipcMain.handle(IPC.PROJECT_CONFIG_SET_TRUST, wrapHandler(IPC.PROJECT_CONFIG_SET_TRUST, async (
    _event: Electron.IpcMainInvokeEvent,
    root: unknown,
    decision: unknown,
    contentHash: unknown,
    unattended: unknown,
  ): Promise<{ ok: boolean }> => {
    if (typeof root !== 'string' || root.length === 0 || root.length > MAX_PATH_LEN) {
      throw new Error('Invalid project root');
    }
    const store = getProjectConfigStore();
    if (decision === 'clear') {
      await store.clearDecision(root);
      return { ok: true };
    }
    if (decision !== 'trusted' && decision !== 'denied') {
      throw new Error('Invalid trust decision');
    }
    if (typeof contentHash !== 'string') throw new Error('Invalid content hash');
    // Unattended reboot-survival consent is a strict opt-in boolean; anything
    // that isn't literally true (absent, non-boolean) is treated as no consent.
    await store.setDecision(root, decision, contentHash, unattended === true);
    return { ok: true };
  }));

  // New workspace setup (renderer-only, like the trust decision: saving
  // approves the written bytes).
  ipcMain.removeHandler(IPC.PROJECT_PREP_GET);
  ipcMain.handle(IPC.PROJECT_PREP_GET, wrapHandler(IPC.PROJECT_PREP_GET, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
  ): Promise<WorkspacePrepSettingsView> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) {
      return { exists: false, settings: { copy: [], setup: '', portRange: '', copyIntoAutomated: false }, copyUnset: true, candidates: [], saveBlocked: 'no-project' };
    }
    return readWorkspacePrepSettings(cwd, prepDeps());
  }));

  ipcMain.removeHandler(IPC.PROJECT_PREP_SAVE);
  ipcMain.handle(IPC.PROJECT_PREP_SAVE, wrapHandler(IPC.PROJECT_PREP_SAVE, async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: unknown,
    rawSettings: unknown,
    expectedHash: unknown,
  ): Promise<WorkspacePrepSaveResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_LEN) return { ok: false, error: 'no-project' };
    const settings = parseWorkspacePrepSettings(rawSettings);
    if (!settings) return { ok: false, error: 'invalid-input' };
    const hash = typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash) ? expectedHash : undefined;
    if (expectedHash !== null && expectedHash !== undefined && hash === undefined) return { ok: false, error: 'invalid-input' };
    return saveWorkspacePrepSettings(cwd, settings, hash, prepDeps());
  }));

  return () => {
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_GET);
    ipcMain.removeHandler(IPC.PROJECT_CONFIG_SET_TRUST);
    ipcMain.removeHandler(IPC.PROJECT_PREP_GET);
    ipcMain.removeHandler(IPC.PROJECT_PREP_SAVE);
  };
}
