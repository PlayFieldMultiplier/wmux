// resolveWslTranscriptPath: a WSL pane's Linux transcript path, read through
// the pane's distro share. A temporary folder stands in for the share
// (`shareRoot`), laid out as the distro's own filesystem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepOwnWslTranscriptPath, resolveWslTranscriptPath, sameSharePath, wslShareRoot } from '../transcriptPathGuard';

const SID = '0a1b2c3d-0000-4000-8000-000000000001';
const DEV = { distribution: 'Ubuntu', user: 'dev' };

/** Whether this process may create a FILE symlink (Windows needs a privilege for it). */
const canSymlink = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
/** Distro name → its stand-in share folder. */
const shares = (distro: string) => path.join(root, distro);
const opts = { platform: 'win32' as const, shareRoot: shares };

/** Create `<share>/<linuxPath>`'s folder, and the file itself unless `noFile`. */
function place(distro: string, linuxPath: string, noFile = false): string {
  const host = path.join(shares(distro), ...linuxPath.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(host), { recursive: true });
  if (!noFile) fs.writeFileSync(host, '{}\n');
  return host;
}

beforeEach(() => {
  // Native, as the resolver's own realpath: a short (8.3) temp name comes back long.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-share-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveWslTranscriptPath', () => {
  it('reads the pane user\'s own transcript through the pane\'s distro share', () => {
    const own = `/home/dev/.claude/projects/-home-dev-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own);
    expect(resolveWslTranscriptPath(own, SID, DEV, opts)).toEqual({ ok: true, hostPath: host });
    // root's home is /root.
    const rootOwn = `/root/.claude/projects/-root-repo/${SID}.jsonl`;
    const rootHost = place('Ubuntu', rootOwn);
    expect(resolveWslTranscriptPath(rootOwn, SID, { distribution: 'Ubuntu', user: 'root' }, opts))
      .toEqual({ ok: true, hostPath: rootHost });
  });

  it('takes the distro and the home from the pane\'s target only', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    place('Debian', own);
    // The same Linux path is read from whichever distro the pane runs in.
    expect(resolveWslTranscriptPath(own, SID, { distribution: 'Debian', user: 'dev' }, opts))
      .toEqual({ ok: true, hostPath: path.join(shares('Debian'), 'home', 'dev', '.claude', 'projects', '-repo', `${SID}.jsonl`) });
    // Another user's home, root's, or a target with no valid distro or user.
    expect(resolveWslTranscriptPath(own, SID, { distribution: 'Ubuntu', user: 'other' }, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(`/root/.claude/projects/-repo/${SID}.jsonl`, SID, DEV, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, { user: 'dev' }, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, { distribution: '..', user: 'dev' }, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, { distribution: 'Ubuntu.', user: 'dev' }, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, { distribution: 'Ubuntu' }, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, undefined, opts).ok).toBe(false);
  });

  it('refuses anything but this session\'s file directly in a project folder', () => {
    place('Ubuntu', `/home/dev/.claude/settings/${SID}.jsonl`);
    place('Ubuntu', `/home/dev/.claude/projects/${SID}.jsonl`);
    place('Ubuntu', `/home/dev/.claude/projects/-repo/nested/${SID}.jsonl`);
    place('Ubuntu', '/home/dev/.claude/projects/-repo/other.jsonl');
    place('Ubuntu', `/etc/${SID}.jsonl`);
    for (const p of [
      `/home/dev/.claude/settings/${SID}.jsonl`,
      `/home/dev/.claude/projects/${SID}.jsonl`,
      `/home/dev/.claude/projects/-repo/nested/${SID}.jsonl`,
      '/home/dev/.claude/projects/-repo/other.jsonl',
      `/etc/${SID}.jsonl`,
      `/home/dev/.claude/projects/-repo/../../../../etc/${SID}.jsonl`,
      `/home/dev/.claude/projects/../projects/-repo/${SID}.jsonl`,
      `/home/dev/.claude/projects/./-repo/${SID}.jsonl`,
      `/home/dev/.claude/projects//-repo/${SID}.jsonl`,
      `/home/dev/.claude/projects/-repo\\..\\..\\x/${SID}.jsonl`,
      `/home/dev/.claude/projects/-re\u0000po/${SID}.jsonl`,
      `/home/dev/.claude/projects/C:/${SID}.jsonl`,
      `/home/dev/.claude/projects/a:b/${SID}.jsonl`,
      `/home/dev/.claude/projects/-repo./${SID}.jsonl`,
      `/home/dev/.claude/projects/nul/${SID}.jsonl`,
      `relative/.claude/projects/-repo/${SID}.jsonl`,
    ]) {
      expect(resolveWslTranscriptPath(p, SID, DEV, opts).ok, p).toBe(false);
    }
    // The session id must be the file's.
    expect(resolveWslTranscriptPath(`/home/dev/.claude/projects/-repo/${SID}.jsonl`, '0a1b2c3d-0000-4000-8000-000000000002', DEV, opts).ok).toBe(false);
  });

  it('serves a file not written yet as pending, only inside a real project folder', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own, true);
    expect(resolveWslTranscriptPath(own, SID, DEV, opts)).toEqual({ ok: true, hostPath: host, pending: true });
    // No project folder yet: nothing to prove containment on.
    expect(resolveWslTranscriptPath(`/home/dev/.claude/projects/-none/${SID}.jsonl`, SID, DEV, opts).ok).toBe(false);
    // A folder at the file's name is not a transcript.
    fs.mkdirSync(host);
    expect(resolveWslTranscriptPath(own, SID, DEV, opts).ok).toBe(false);
  });

  it('refuses a project folder linked out of the projects root', () => {
    const outside = path.join(shares('Ubuntu'), 'etc');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, `${SID}.jsonl`), '{}\n');
    const projects = path.join(shares('Ubuntu'), 'home', 'dev', '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    // A junction needs no privilege on Windows; elsewhere it is a directory link.
    fs.symlinkSync(outside, path.join(projects, '-escape'), 'junction');
    expect(resolveWslTranscriptPath(`/home/dev/.claude/projects/-escape/${SID}.jsonl`, SID, DEV, opts).ok).toBe(false);
  });

  it.skipIf(!canSymlink)('refuses a transcript that is a link, wherever it points', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own, true);
    const secret = path.join(shares('Ubuntu'), 'secret');
    fs.writeFileSync(secret, 'x');
    fs.symlinkSync(secret, host, 'file');
    expect(resolveWslTranscriptPath(own, SID, DEV, opts).ok).toBe(false);
    fs.unlinkSync(host);
    const sibling = place('Ubuntu', '/home/dev/.claude/projects/-repo/other.jsonl');
    fs.symlinkSync(sibling, host, 'file');
    expect(resolveWslTranscriptPath(own, SID, DEV, opts).ok).toBe(false);
  });

  // The resolver runs on Windows only. macOS's realpath does not promise the
  // on-disk spelling, so a case-insensitive APFS volume cannot stand in here.
  it.skipIf(process.platform === 'darwin')('refuses a case variant of the real path: Linux names are case-sensitive', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    const variant = `/home/dev/.claude/projects/-Repo/${SID}.jsonl`;
    expect(resolveWslTranscriptPath(variant, SID, DEV, opts).ok).toBe(false);
    // Nor a variant of a project folder that exists, for a file not written yet.
    fs.unlinkSync(path.join(shares('Ubuntu'), 'home', 'dev', '.claude', 'projects', '-repo', `${SID}.jsonl`));
    expect(resolveWslTranscriptPath(`/home/dev/.claude/projects/-REPO/${SID}.jsonl`, SID, DEV, opts).ok).toBe(false);
    expect(resolveWslTranscriptPath(own, SID, DEV, opts)).toMatchObject({ ok: true, pending: true });
  });

  it.runIf(process.platform === 'win32')('accepts the share named in another case, as Windows matches it', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    const upper = (distro: string) => shares(distro).toUpperCase();
    expect(resolveWslTranscriptPath(own, SID, DEV, { ...opts, shareRoot: upper }).ok).toBe(true);
  });

  it('compares the share prefix without case and everything below it exactly', () => {
    const B = '\\';
    const share = `${B}${B}wsl$${B}Ubuntu`;
    const lexical = `${share}${B}home${B}dev${B}.claude${B}projects${B}-repo${B}${SID}.jsonl`;
    // realpath returns the prefix as given; a differently cased share name is the same share.
    expect(sameSharePath(lexical, lexical, share)).toBe(true);
    expect(sameSharePath(lexical.replace(`wsl$${B}Ubuntu`, `WSL$${B}ubuntu`), lexical, share)).toBe(true);
    // A different share, or any case change below it, is another path.
    expect(sameSharePath(lexical.replace('Ubuntu', 'Debian'), lexical, share)).toBe(false);
    expect(sameSharePath(lexical.replace('-repo', '-Repo'), lexical, share)).toBe(false);
    expect(sameSharePath(lexical.replace('.claude', '.Claude'), lexical, share)).toBe(false);
    expect(sameSharePath(`${lexical}x`, lexical, share)).toBe(false);
    // The lexical path itself must sit under the share.
    expect(sameSharePath(lexical, lexical, `${B}${B}wsl$${B}Debian`)).toBe(false);
  });

  it('applies on Windows only', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(resolveWslTranscriptPath(own, SID, DEV, { ...opts, platform }).ok).toBe(false);
    }
  });

  it('keeps a binding\'s Linux transcript path only for that WSL pane\'s own Claude', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const b = { agent: 'claude', sessionId: SID, cwd: '/home/dev/repo', wslTranscriptPath: own, ts: 1 };
    expect(keepOwnWslTranscriptPath(b, DEV)).toEqual({ binding: b, dropped: false });
    // A non-WSL pane (no target), another user, or another agent: dropped, the rest kept.
    const rest: Omit<typeof b, 'wslTranscriptPath'> & { wslTranscriptPath?: string } = { ...b };
    delete rest.wslTranscriptPath;
    for (const [binding, target] of [
      [b, undefined],
      [b, { distribution: 'Ubuntu', user: 'other' }],
      [{ ...b, agent: 'codex' }, DEV],
    ] as const) {
      const kept = keepOwnWslTranscriptPath(binding, target);
      expect(kept.dropped).toBe(true);
      expect(kept.binding).toEqual({ ...rest, agent: binding.agent });
    }
    // A binding without one is untouched.
    expect(keepOwnWslTranscriptPath(rest, undefined)).toEqual({ binding: rest, dropped: false });
  });

  it('names the distro share', () => {
    expect(wslShareRoot('Ubuntu-24.04')).toBe('\\\\wsl$\\Ubuntu-24.04');
  });
});
