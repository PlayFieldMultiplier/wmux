// A worker create carrying secrets starts in the folder its grant names,
// or not at all.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home', on: () => undefined },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {},
}));

import { secretCreateCwdRefusal } from '../pty.handler';

describe('secretCreateCwdRefusal', () => {
  const dir = path.resolve('/w/task');

  it('allows the folder the grant names, however it is spelled', () => {
    expect(secretCreateCwdRefusal(dir, { incomingCwd: dir, safeCwd: dir, source: 'requested' })).toBeNull();
    expect(secretCreateCwdRefusal(`${dir}/./`, { incomingCwd: dir, safeCwd: dir, source: 'requested' })).toBeNull();
  });

  it('refuses a folder that is gone (the home fallback), a recovery folder, or another folder', () => {
    expect(secretCreateCwdRefusal(dir, { incomingCwd: dir, source: 'requested' })).toMatch(/folder its grant names/);
    expect(secretCreateCwdRefusal(dir, { incomingCwd: '/w/old', safeCwd: '/w/old', source: 'recovery-cwd' })).not.toBeNull();
    expect(secretCreateCwdRefusal(dir, { incomingCwd: dir, safeCwd: dir, source: 'recovery-spawnCwd' })).not.toBeNull();
    expect(secretCreateCwdRefusal(dir, { incomingCwd: '/w/other', safeCwd: path.resolve('/w/other'), source: 'requested' })).not.toBeNull();
    expect(secretCreateCwdRefusal(undefined, { incomingCwd: dir, safeCwd: dir, source: 'requested' })).not.toBeNull();
  });

  it('the daemon create checks it before the session exists', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'), 'utf8');
    const check = src.indexOf('secretCreateCwdRefusal(grantedCwd, cwdResolution)');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("daemonClient.rpc('daemon.createSession'"));
    expect(check).toBeLessThan(src.indexOf('noteBotWorkerSession(sessionId'));
  });
});
