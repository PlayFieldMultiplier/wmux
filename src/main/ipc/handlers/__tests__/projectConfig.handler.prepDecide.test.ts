// workspace-prep:decide passes every decision the card offers through to the
// cards, Discard included, and refuses anything else before it reaches them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

const decide = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../worktask/workspacePrepCards', () => ({
  getWorkspacePrepCards: () => ({ decide, list: () => [] }),
}));

import { registerProjectConfigHandlers } from '../projectConfig.handler';
import { IPC } from '../../../../shared/constants';
import { WORKSPACE_PREP_DECISIONS } from '../../../../shared/workspacePrepCard';

let dispose: () => void;
beforeEach(() => { decide.mockClear(); dispose = registerProjectConfigHandlers(); });
afterEach(() => dispose());

const call = (...args: unknown[]) => captured.get(IPC.WORKSPACE_PREP_DECIDE)!({} as never, ...args);

describe('workspace-prep:decide', () => {
  it.each(WORKSPACE_PREP_DECISIONS)('hands %s to the cards', async (decision) => {
    expect(await call('card-1', decision)).toEqual({ ok: true });
    expect(decide).toHaveBeenCalledWith('card-1', decision);
  });

  it('refuses an unknown decision without reaching the cards', async () => {
    expect(await call('card-1', 'delete')).toEqual({ ok: false });
    expect(decide).not.toHaveBeenCalled();
  });
});
