// The Log in card of a bot parked signed out opens the sign-in of the
// account that bot runs on, not only main's own folder.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

import { botLoginConfigDir, factoryEngineLoginHandler } from '../factory.handler';
import { resolveConversationAccount } from '../../../account/backgroundLaunchAccount';

const BOT = 'bot-0000000a';
const account = { id: 'acc-1', vendor: 'claude' as const, name: 'Work', configDir: '/accounts/work' };
const store = {
  getAccount: (id: string) => (id === account.id ? account : undefined),
  getBinding: (ws: string) => (ws === 'ws-bound' ? account.id : undefined),
  resolveAccountEnv: (ws: string): Record<string, string> => (ws === 'ws-bound' ? { CLAUDE_CONFIG_DIR: account.configDir } : {}),
};
const resolve: typeof resolveConversationAccount = (ws, vendor, id) =>
  resolveConversationAccount(ws, vendor, id, { store: store as never, dirExists: () => true });

describe('botLoginConfigDir', () => {
  it('the account the bot\'s conversation runs on, else its workspace binding, else main\'s own folder', () => {
    const ports = (ws: string | null, acc: string | null | undefined) => ({ workspaceOf: () => ws, accountOf: () => acc, resolve });
    expect(botLoginConfigDir(BOT, ports('ws-plain', 'acc-1'))).toBe('/accounts/work');
    expect(botLoginConfigDir(BOT, ports('ws-bound', undefined))).toBe('/accounts/work');
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/main/claude';
    try {
      expect(botLoginConfigDir(BOT, ports('ws-plain', undefined))).toBe('/main/claude');
      // A conversation on the default sign-in stays there, whatever the binding.
      expect(botLoginConfigDir(BOT, ports('ws-bound', null))).toBe('/main/claude');
      expect(botLoginConfigDir(BOT, ports(null, 'acc-1'))).toBe('/main/claude');
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prior;
    }
  });
});

describe('factoryEngineLoginHandler', () => {
  it('signs in to the named bot\'s folder; refuses a malformed bot id', async () => {
    const win = { webContents: { id: 1, mainFrame: { url: 'app://x' } }, isDestroyed: () => false };
    const openTab = vi.fn(async () => ({ ptyId: 'pty-1' }));
    const handler = factoryEngineLoginHandler(() => win as never, { openTab, windowsShell: () => 'powershell.exe', platform: 'linux', botConfigDir: () => '/accounts/work' });
    const e = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    await handler(e, { botId: BOT });
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(String((openTab.mock.calls[0] as unknown[])[1])).toContain('/accounts/work');
    for (const bad of [{ botId: '../x' }, { botId: 7 }, { botId: null }, {}, null, 'bot-0000000a']) {
      await expect(handler(e, bad)).rejects.toThrow(/not a bot id/);
    }
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});
