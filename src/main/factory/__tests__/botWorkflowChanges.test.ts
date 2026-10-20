// The owner's workflow card reads two things main records: when a step's
// verified result was recorded, and a bot event whenever a workflow
// changes (the Bots page re-reads on it).
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import type { BrowserWindow } from 'electron';
import { BOT_EVENT } from '../../../shared/bot';
import { LEDGER_SCHEMA_VERSION, type LedgerEntry } from '../../../shared/ledger';
import { BotWorkflowStore, onBotWorkflowsChanged, setBotWorkflowStore, workflowTaskResult } from '../botWorkflow';
import { registerWorkflowHandlers } from '../../ipc/handlers/workflow.handler';

const owner = { botId: 'bot-a', workspaceId: 'ws-owner', repoKey: 'github.com/acme/repo', threadId: 'general' as const, tainted: true };
const input = { clientWorkflowId: 'plan-a', title: 'Two steps', steps: [{ title: 'first', prompt: 'make first change' }, { title: 'second', prompt: 'build on first' }] };
const store = () => new BotWorkflowStore('/nonexistent/factory/workflows.json', () => 42, async () => undefined);

function merged(workflowId: string): LedgerEntry {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION, id: 'wtask-one', taskWorkspaceId: 'ws-worker', ownerWorkspaceId: owner.workspaceId,
    title: 'first', status: 'completed', rev: 5, updatedAt: 1_234, updatedBy: { kind: 'brain', workspaceId: owner.workspaceId },
    dispatch: { origin: { kind: 'bot', botId: owner.botId }, repoKey: owner.repoKey, workflow: { id: workflowId, step: 0 } },
    completion: { source: 'merge', pr: 7 }, summary: 'merged',
  } as LedgerEntry;
}

describe('workflow readback for the owner', () => {
  it('a verified result records when its task completed', async () => {
    expect(workflowTaskResult(merged('wf-x'))).toEqual({ taskId: 'wtask-one', rev: 5, mergedPr: 7, summary: 'merged', at: 1_234 });
    const s = store();
    const w = await s.create(owner, input);
    await s.claim(w.id, w.botId, w.workspaceId, 'wake:one:1');
    await s.reconcile([merged(w.id)]);
    expect(s.get(w.id, w.botId, w.workspaceId)?.steps[0].result).toMatchObject({ mergedPr: 7, at: 1_234 });
  });

  it('every persisted change tells the window, and an unchanged write does not', async () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    const s = store();
    setBotWorkflowStore(s);
    const cleanup = registerWorkflowHandlers(() => win);
    const throwing = onBotWorkflowsChanged(() => { throw new Error('listener'); });
    try {
      const w = await s.create(owner, input);
      expect(send).toHaveBeenLastCalledWith(BOT_EVENT, { type: 'bots-changed' });
      const calls = send.mock.calls.length;
      await s.create(owner, input);
      expect(send).toHaveBeenCalledTimes(calls);
      await s.cancel(w.id, w.botId, w.workspaceId, w.revision);
      expect(send).toHaveBeenCalledTimes(calls + 1);
    } finally {
      throwing();
      cleanup();
      setBotWorkflowStore(null);
    }
    // Unregistered, the handlers tell nobody.
    const after = send.mock.calls.length;
    await s.create(owner, { ...input, clientWorkflowId: 'plan-b' });
    expect(send).toHaveBeenCalledTimes(after);
  });
});
