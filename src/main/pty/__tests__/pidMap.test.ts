import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePidMap, removePidMapByPtyId } from '../pidMap';
import { getPidMapDir } from '../../../shared/constants';

/**
 * Behavioral test for the pid-map fs primitives behind the ghost-identity fix.
 *
 * The structural test (src/main/ipc/__tests__/pty.handler.pidmap-prune.test.ts)
 * proves the dispose + session:died handlers CALL removePidMapByPtyId. This one
 * proves the call actually does the right thing on a real filesystem — the
 * content-keying invariant the whole ghost defense rests on: prune by file
 * CONTENT (ptyId), never by filename (the recyclable OS PID).
 *
 * getPidMapDir() resolves `${USERPROFILE || HOME}/.wmux${dataSuffix()}/pid-map` at call time,
 * so we redirect both env vars at a throwaway tmpdir and run the real code.
 */
describe('pidMap fs primitives', () => {
  let tmp: string;
  let savedUserProfile: string | undefined;
  let savedHome: string | undefined;
  let mapDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pidmap-'));
    savedUserProfile = process.env.USERPROFILE;
    savedHome = process.env.HOME;
    // getPidMapDir() prefers USERPROFILE, falls back to HOME — pin both so the
    // test is platform-independent.
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    mapDir = getPidMapDir();
    fs.mkdirSync(mapDir, { recursive: true });
  });

  afterEach(() => {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const seed = (pid: string | number, ptyId: string) =>
    fs.writeFileSync(path.join(mapDir, String(pid)), ptyId, 'utf8');
  const exists = (pid: string | number) =>
    fs.existsSync(path.join(mapDir, String(pid)));

  it('writePidMap creates the dir and writes ptyId as the file CONTENT', () => {
    writePidMap(1234, 'daemon-abc');
    expect(exists(1234)).toBe(true);
    expect(fs.readFileSync(path.join(mapDir, '1234'), 'utf8')).toBe('daemon-abc');
  });

  it('writePidMap keeps one PID per ptyId: an earlier shell of the same pane is removed', () => {
    // Live repro (Windows, after two daemon restarts): pane daemon-04f1c884
    // had PIDs 6780 and 13632 before its current shell 7644. Windows then
    // gave 6780 to a new worker's claude.exe, whose MCP walk matched it and
    // took the old pane's identity.
    seed(6780, 'daemon-04f1c884');
    seed(13632, 'daemon-04f1c884');
    seed(14932, 'daemon-d1fe97e3');
    writePidMap(7644, 'daemon-04f1c884');
    expect(exists(7644)).toBe(true);
    expect(exists(6780)).toBe(false);
    expect(exists(13632)).toBe(false);
    // Other panes' anchors are untouched.
    expect(fs.readFileSync(path.join(mapDir, '14932'), 'utf8')).toBe('daemon-d1fe97e3');
  });

  it('writePidMap over a recycled PID of another pane re-points it, leaving that pane\'s other anchors alone', () => {
    seed(500, 'daemon-old');
    seed(600, 'daemon-old');
    writePidMap(500, 'daemon-new');
    expect(fs.readFileSync(path.join(mapDir, '500'), 'utf8')).toBe('daemon-new');
    expect(fs.readFileSync(path.join(mapDir, '600'), 'utf8')).toBe('daemon-old');
  });

  it('removePidMapByPtyId deletes EVERY entry whose content matches the ptyId', () => {
    // The accretion case: one ptyId can have multiple PID anchors (shell
    // respawn / reconnect writes a fresh PID without removing the old one).
    // Pruning must sweep them all in one call.
    seed(100, 'daemon-A');
    seed(200, 'daemon-A');
    seed(300, 'daemon-B');

    removePidMapByPtyId('daemon-A');

    expect(exists(100)).toBe(false);
    expect(exists(200)).toBe(false);
    expect(exists(300)).toBe(true); // unrelated ptyId untouched
  });

  it('matches by CONTENT, not by filename — a PID-named file is NOT removed by PID', () => {
    // Guards the core ghost invariant. If the prune ever flipped to filename
    // matching, recycled-PID entries (the ones that produce ghosts) would
    // survive while a same-numbered live anchor got wrongly deleted.
    seed(555, 'daemon-X'); // filename "555", content "daemon-X"

    removePidMapByPtyId('555'); // ask to prune ptyId "555" — content, not name
    expect(exists(555)).toBe(true); // file named 555 stays (its content ≠ "555")

    removePidMapByPtyId('daemon-X'); // prune by actual content
    expect(exists(555)).toBe(false);
  });

  it('trims trailing whitespace/newline before comparing content', () => {
    // Anchors written by other paths may carry a trailing newline; the match
    // must be whitespace-insensitive or stale entries would never clear.
    fs.writeFileSync(path.join(mapDir, '777'), 'daemon-nl\n', 'utf8');
    removePidMapByPtyId('daemon-nl');
    expect(exists(777)).toBe(false);
  });

  it('is a safe no-op on empty ptyId and a missing map dir', () => {
    seed(900, 'daemon-keep');
    removePidMapByPtyId(''); // empty → must not nuke the whole dir
    expect(exists(900)).toBe(true);

    // Missing dir must not throw.
    fs.rmSync(mapDir, { recursive: true, force: true });
    expect(() => removePidMapByPtyId('daemon-anything')).not.toThrow();
  });
});
