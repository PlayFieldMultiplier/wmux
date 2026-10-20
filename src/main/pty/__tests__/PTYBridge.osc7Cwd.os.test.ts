import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Local-mode OSC 7: a report that is not a local folder leaves the pane's cwd
// as it was; a WSL distro's own hostname is accepted.

const mocks = vi.hoisted(() => ({ updateCwd: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: mocks.updateCwd,
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: vi.fn(),
  getLastBroadcastAgentStatus: () => undefined,
  clearLastBroadcastAgentStatus: () => { /* no-op stub */ },
}));

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';
import { IPC } from '../../../shared/constants';

const realPlatform = process.platform;

function makeBridge(shell: string, platform: NodeJS.Platform = realPlatform) {
  let dataCb: ((data: string) => void) | null = null;
  const proc = { onData: (cb: (d: string) => void) => { dataCb = cb; }, onExit: () => { /* not observed */ } };
  const instance: PTYInstance = { id: 'p1', process: proc as unknown as PTYInstance['process'], shell };
  const manager = { get: vi.fn(() => instance), remove: vi.fn(), onDispose: vi.fn() } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    new PTYBridge(manager, () => win as never).setupDataForwarding('p1');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
  const sentCwds = () => win.webContents.send.mock.calls.filter((c) => c[0] === IPC.CWD_CHANGED).map((c) => c[2]);
  // Output is parsed on the bridge's micro-batch flush.
  const feed = (d: string) => { dataCb?.(d); vi.advanceTimersByTime(50); };
  return { feed, sentCwds };
}

describe('PTYBridge OSC 7 cwd', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    mocks.updateCwd.mockReset();
  });

  it('ignores a report from another host or of a network path', () => {
    const { feed, sentCwds } = makeBridge('bash');
    feed('\x1b]7;file://localhost/home/me\x07');
    feed('\x1b]7;file://other-machine.example/home/elsewhere\x07');
    feed('\x1b]7;file://localhost///server/share\x07');
    expect(sentCwds()).toEqual(['/home/me']);
    expect(mocks.updateCwd.mock.calls.map((c) => c[1])).toEqual(['/home/me']);
    feed('\x1b]7;file:///home/next\x07');
    expect(sentCwds()).toEqual(['/home/me', '/home/next']);
  });

  it("takes a WSL distro's own hostname, but not its network paths", () => {
    const { feed, sentCwds } = makeBridge('C:\\Windows\\System32\\wsl.exe', 'win32');
    feed('\x1b]7;file://ubuntu-dev/home/me\x07');
    feed('\x1b]7;file://ubuntu-dev///server/share\x07');
    expect(sentCwds()).toEqual(['/home/me']);
  });
});
