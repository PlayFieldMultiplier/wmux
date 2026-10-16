import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Local PTY mode writes the same pid-map anchors as daemon mode, through the
// shared helpers, so a pane keeps one PID and dispose clears it by content.
const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 4321, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn() })),
}));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));
import { PTYManager } from '../PTYManager';
import { getPidMapDir } from '../../../shared/constants';

describe('PTYManager pid-map anchors', () => {
  let tmp: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;
  let mapDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ptymgr-pidmap-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    mapDir = getPidMapDir();
    spawn.mockClear();
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = (pid: string | number) => {
    try { return fs.readFileSync(path.join(mapDir, String(pid)), 'utf8'); } catch { return null; }
  };

  it('writes the shell PID through the shared writer, dropping an earlier PID of the same pane', () => {
    const manager = new PTYManager();
    try {
      fs.mkdirSync(mapDir, { recursive: true });
      // An earlier anchor for the id this manager mints first.
      fs.writeFileSync(path.join(mapDir, '1111'), 'pty-1', 'utf8');
      fs.writeFileSync(path.join(mapDir, '2222'), 'daemon-other', 'utf8');

      const instance = manager.create({});
      expect(instance.id).toBe('pty-1');
      expect(read(4321)).toBe('pty-1');
      expect(read(1111)).toBeNull();
      expect(read(2222)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });

  it('dispose removes the pane\'s anchors by content, leaving a file another pane owns', () => {
    const manager = new PTYManager();
    try {
      const instance = manager.create({});
      expect(read(4321)).toBe(instance.id);
      fs.writeFileSync(path.join(mapDir, '2222'), 'daemon-other', 'utf8');

      manager.dispose(instance.id);

      expect(read(4321)).toBeNull();
      expect(read(2222)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });

  it('dispose does not remove a file whose PID now names another pane', () => {
    const manager = new PTYManager();
    try {
      const instance = manager.create({});
      // The PID file was re-pointed to a different pane (reused PID).
      fs.writeFileSync(path.join(mapDir, '4321'), 'daemon-other', 'utf8');

      manager.dispose(instance.id);

      expect(read(4321)).toBe('daemon-other');
    } finally { manager.disposeAll(); }
  });
});
