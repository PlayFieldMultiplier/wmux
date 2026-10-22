// The wiring's wake context reads the room as the waking bot: the owner's
// words in another bot's 1:1 reach no other bot's wake.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' }, BrowserWindow: class {}, ipcMain: { handle: () => undefined, on: () => undefined } }));

import { createFactoryWiring } from '../factoryWiring';
import { __botRuntimePortsForTesting, __resetBotRuntimePortsForTesting } from '../BotRuntime';
import { RoomWriter, setRoomWriter } from '../roomWriter';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { ThreadId } from '../../../shared/room';
import type { WakeItem } from '../../../shared/wake';

const A = 'bot-0000aaaa';
const B: BotProfile = {
  version: 1, id: 'bot-0000bbbb', workspaceId: 'ws-1', role: 'maintainer', name: 'Triage', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { ...DEFAULT_BOT_BUDGETS.maintainer }, enabled: true, createdAt: 1, updatedAt: 1,
};

let dir = '';
afterEach(() => {
  setRoomWriter(null);
  __resetBotRuntimePortsForTesting();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the wiring\'s wake context', () => {
  it('takes no language sample or card from another bot\'s 1:1 with the owner', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wiring-ctx-'));
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    setRoomWriter(writer);
    const dm = `dm:${A}` as ThreadId;
    const said = writer.append({ workspaceId: 'ws-1', threadId: dm, kind: 'human', actor: { kind: 'human' }, title: 'Q3 revenue is 4.2M' });
    writer.append({ workspaceId: 'ws-1', threadId: dm, kind: 'status', actor: { kind: 'bot', workspaceId: 'ws-1', botId: A }, title: 'A REPLY ABOUT Q3' });
    const wiring = createFactoryWiring({ wmuxDir: () => dir });
    try {
      const wakeContext = __botRuntimePortsForTesting().wakeContext;
      expect(wakeContext).toBeTypeOf('function');
      const wake = (reason: WakeItem['reason'], threadId?: ThreadId): WakeItem => ({ id: 'w', botId: B.id, workspaceId: 'ws-1', reason, priority: 0, enqueuedAt: 1, attempts: 1, state: 'running', ...(threadId ? { threadId } : {}) });
      const items = [
        wake({ kind: 'routine', routineId: 'r-1', dueAt: 1 }),
        wake({ kind: 'facts', factIds: [], trigger: { kind: 'pr.opened' } }),
        // A room message naming the 1:1's card: no reply posted after it there.
        wake({ kind: 'human', text: 'hi all', source: 'desktop', room: true, clientMessageId: said?.id ?? 'x' }, dm),
      ];
      for (const item of items) {
        const ctx = wakeContext!(B, item);
        expect(JSON.stringify(ctx), item.reason.kind).not.toContain('Q3');
      }
    } finally {
      wiring.dispose?.();
    }
  });
});
