// The owner's Hermes controls: only the main window moves a bot onto Hermes
// or opens the setup tab.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

import { factoryBotSetEngineHandler, factoryHermesReadinessHandler, factoryHermesSetupHandler } from '../factory.handler';
import { HERMES_BOT_ENGINE, type BotEngine, type BotProfile } from '../../../../shared/bot';

const BOT = 'bot-0000000a';
const win = { webContents: { id: 1, mainFrame: { url: 'app://x' } }, isDestroyed: () => false };
const main = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
const other = { sender: { id: 2, mainFrame: { url: 'app://x' } }, senderFrame: { url: 'app://x' } };

describe('factoryBotSetEngineHandler', () => {
  it('moves a bot to Hermes and back for the main window only; the next turn respawns', async () => {
    let engine: BotEngine = { kind: 'claude-sdk', model: 'opus' };
    const update = vi.fn((_id: string, patch: { engine: BotEngine }) => {
      engine = patch.engine;
      return { ok: true as const, bot: { id: BOT, engine } as BotProfile };
    });
    const store = { get: (id: string) => (id === BOT ? ({ id: BOT, engine } as BotProfile) : null), update };
    const profileChanged = vi.fn();
    const handler = factoryBotSetEngineHandler(() => win as never, { store: () => store as never, runtime: () => ({ profileChanged }) });

    expect(await handler(other, { botId: BOT, engine: 'hermes' })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await handler(main, { botId: BOT, engine: { kind: 'acp', command: 'sh', args: [] } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await handler(main, { botId: '../x', engine: 'hermes' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    // Already on Claude: the model stays.
    expect(await handler(main, { botId: BOT, engine: 'claude-sdk' })).toEqual({ ok: true });
    expect(update).not.toHaveBeenCalled();

    expect(await handler(main, { botId: BOT, engine: 'hermes' })).toEqual({ ok: true });
    expect(engine).toEqual(HERMES_BOT_ENGINE);
    expect(profileChanged).toHaveBeenLastCalledWith(BOT);
    expect(await handler(main, { botId: BOT, engine: 'claude-sdk' })).toEqual({ ok: true });
    expect(engine).toEqual({ kind: 'claude-sdk' });
    expect(profileChanged).toHaveBeenCalledTimes(2);
  });
});

describe('factoryHermesSetupHandler', () => {
  it('opens a tab with the host\'s setup line; no line or no tab is an error', async () => {
    const openTab = vi.fn(async () => ({ ptyId: 'pty-1' }));
    let line: string | null = "env -i HERMES_HOME='/d/factory/hermes' '/bin/hermes' model";
    const handler = factoryHermesSetupHandler(() => win as never, { openTab, windowsShell: () => 'cmd.exe', platform: 'darwin', host: () => ({ setupLine: () => line }) });
    await expect(handler(other)).rejects.toThrow(/main window/);
    await handler(main);
    expect(openTab).toHaveBeenCalledWith(undefined, line);
    line = null;
    await expect(handler(main)).rejects.toThrow(/could not find Hermes/);
    line = 'x';
    openTab.mockResolvedValueOnce(null as never);
    await expect(handler(main)).rejects.toThrow(/could not open a terminal/);
  });
});

describe('factoryHermesReadinessHandler', () => {
  it('answers the main window only, afresh when asked', async () => {
    const readiness = vi.fn(async (fresh?: boolean) => ({ ready: true, version: fresh ? 'fresh' : 'cached' }));
    const handler = factoryHermesReadinessHandler(() => win as never, () => ({ readiness }) as never);
    expect(await handler(other)).toMatchObject({ ready: false, reason: 'unknown' });
    expect(await handler(main)).toMatchObject({ version: 'cached' });
    expect(await handler(main, { fresh: true })).toMatchObject({ version: 'fresh' });
    expect(readiness).toHaveBeenCalledTimes(2);
  });
});
