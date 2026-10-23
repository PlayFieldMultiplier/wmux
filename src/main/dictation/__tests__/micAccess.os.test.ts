// The microphone's OS access: asked on macOS the first time, never asked for
// Chromium's fake capture device (a test clip).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  status: 'not-determined',
  asked: 0,
  answer: true,
  switches: new Set<string>(),
}));

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: (s: string) => electron.switches.has(s) }, isPackaged: true, getAppPath: () => '/app' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: () => electron.status,
    askForMediaAccess: async () => {
      electron.asked += 1;
      return electron.answer;
    },
  },
}));

import { micAccess } from '../dictation.handler';

beforeEach(() => {
  electron.status = 'not-determined';
  electron.asked = 0;
  electron.answer = true;
  electron.switches.clear();
});

describe('micAccess', () => {
  it('asks macOS once when nothing is decided, and takes its answer', async () => {
    expect(await micAccess('darwin')).toBe('granted');
    electron.answer = false;
    expect(await micAccess('darwin')).toBe('denied');
    expect(electron.asked).toBe(2);
    electron.status = 'denied';
    expect(await micAccess('darwin')).toBe('denied');
    expect(electron.asked).toBe(2);
  });

  it('asks nothing for the fake capture device, nor off macOS', async () => {
    electron.switches.add('use-fake-device-for-media-stream');
    expect(await micAccess('darwin')).toBe('granted');
    electron.switches.clear();
    expect(await micAccess('win32')).toBe('granted');
    expect(electron.asked).toBe(0);
  });
});
