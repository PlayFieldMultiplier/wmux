import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC, dataSuffix } from '../../../shared/constants';
import { isFirewallListener, type ElevationOutcome, type FirewallActionResult, type InboundStatusView } from '../../../shared/netFirewall';
import { FIREWALL_GROUP, currentRuleUser, elevatedPowerShellParameters, windowsPowerShellPath } from '../../../shared/netFirewallScripts';
import type { ListenProblemReport } from '../../../shared/netListen';
import { wrapHandler } from '../wrapHandler';
import { isMainWindowSender } from '../mainWindowSender';
import type { DaemonClient } from '../../DaemonClient';
import { FirewallFixer } from '../../net/firewallFix';
import { shellExecuteAndWait, tokenElevationType } from '../../net/elevate';
import { isSelfElevated } from '../../computer/selfElevation';

// The firewall and port problems of remote pairing (A2A, Share & pair with
// "Expose to network", LanLink): the read-only checks pass through to the
// daemon (`net.*`), and the Fix / Remove run here, in main, through the OS
// consent prompt. Only the main window's own top frame may ask for an
// elevation, one click at a time (FirewallFixer).

let liveClient: (() => DaemonClient | null) | null = null;

function rpcClient(): DaemonClient {
  const dc = liveClient?.() ?? null;
  if (!dc || !dc.isConnected) throw Object.assign(new Error('the daemon is not connected'), { code: 'DAEMON_DISCONNECTED' });
  return dc;
}

/** macOS: the admin sheet. Unverified on a Mac: osascript reports a declined sheet as error -128. */
function runAppleScript(script: string): Promise<ElevationOutcome> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (!err) resolve({ kind: 'ok' });
      else if (/\(-128\)/.test(String(stderr))) resolve({ kind: 'cancelled' });
      else resolve({ kind: 'failed', stage: null, code: typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null });
    });
  });
}

let getMainWindow: () => BrowserWindow | null = () => null;

const fixer = new FirewallFixer({
  rpc: (method, params, opts) => rpcClient().rpc(method, params, opts),
  elevateWindows: (script) =>
    shellExecuteAndWait({
      verb: 'runas',
      file: windowsPowerShellPath(),
      parameters: elevatedPowerShellParameters(script),
      hwnd: (() => {
        const win = getMainWindow();
        return win && !win.isDestroyed() ? win.getNativeWindowHandle() : null;
      })(),
    }),
  elevateMac: runAppleScript,
  exists: (p) => fs.existsSync(p),
  scope: { dataSuffix: dataSuffix(), user: currentRuleUser(), group: FIREWALL_GROUP },
  tokenType: tokenElevationType,
  selfElevated: isSelfElevated,
  log: (msg) => console.warn(msg),
});

const NOT_OPERATOR: FirewallActionResult = { outcome: { kind: 'refused', refusal: 'changed' }, status: null };

function openFirewallSettings(): void {
  if (process.platform === 'win32') {
    // wf.msc through the absolute mmc.exe: Windows Defender Firewall with Advanced Security.
    const root = process.env['SystemRoot'] || 'C:\\Windows';
    const child = spawn(path.win32.join(root, 'System32', 'mmc.exe'), [path.win32.join(root, 'System32', 'wf.msc')], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => console.warn('[net] could not open Windows Firewall:', err.message));
    child.unref();
    return;
  }
  if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall');
}

function openNetworkSettings(): void {
  if (process.platform === 'win32') void shell.openExternal('ms-settings:network-status');
  else if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.Network-Settings.extension');
}

export function registerNetFirewallHandlers(getDaemonClient: () => DaemonClient | null, getWindow: () => BrowserWindow | null): () => void {
  liveClient = getDaemonClient;
  getMainWindow = getWindow;
  const listener = (v: unknown) => {
    if (!isFirewallListener(v)) throw new Error('listener must be one of a2a, web, lanlink');
    return v;
  };
  const handlers: Array<[string, (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>]> = [
    [IPC.NET_FIREWALL_STATUS, async (_e, l): Promise<InboundStatusView> => fixer.status(listener(l))],
    [IPC.NET_LISTEN_PROBLEM, async (_e, l): Promise<ListenProblemReport | null> => fixer.listenProblem(listener(l))],
    [
      IPC.NET_FIREWALL_FIX,
      async (e, l): Promise<FirewallActionResult> => (isMainWindowSender(e, getWindow()) ? fixer.fix(listener(l)) : NOT_OPERATOR),
    ],
    [
      IPC.NET_FIREWALL_REMOVE,
      async (e, l): Promise<FirewallActionResult> => (isMainWindowSender(e, getWindow()) ? fixer.remove(listener(l)) : NOT_OPERATOR),
    ],
    [
      IPC.NET_FIREWALL_OPEN,
      async (e, which): Promise<{ ok: boolean }> => {
        if (!isMainWindowSender(e, getWindow())) return { ok: false };
        if (which === 'firewall') openFirewallSettings();
        else if (which === 'network') openNetworkSettings();
        else return { ok: false };
        return { ok: true };
      },
    ],
  ];
  for (const [channel, fn] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, fn));
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
