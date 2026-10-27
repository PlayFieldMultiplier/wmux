// A WSL pane's Linux transcript path, read through the pane's distro share:
// wslTranscriptSharePath (where it is, without touching the disk) and
// proveWslTranscriptPath (that it is what it claims). A temporary folder
// stands in for the share (`shareRoot`), laid out as the distro's filesystem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  keepOwnWslTranscriptPath,
  proveWslTranscriptPath,
  sameSharePath,
  wslTranscriptSharePath,
  type WslShareFs,
} from '../transcriptPathGuard';

const SID = '0a1b2c3d-0000-4000-8000-000000000001';
const DEV = { distribution: 'Ubuntu', user: 'dev' };
const UNREACHABLE = 'not reachable on the share (a link, or missing)';

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

/** Both steps, as the projector runs them. */
async function resolve(
  wslPath: string,
  sid: string,
  target: Parameters<typeof wslTranscriptSharePath>[2],
  o: Parameters<typeof wslTranscriptSharePath>[3] = opts,
) {
  const at = wslTranscriptSharePath(wslPath, sid, target, o);
  return at.ok ? proveWslTranscriptPath(at) : at;
}

/** Create `<share>/<linuxPath>`'s folder, and the file itself unless `noFile`. */
function place(distro: string, linuxPath: string, noFile = false): string {
  const host = path.join(shares(distro), ...linuxPath.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(host), { recursive: true });
  if (!noFile) fs.writeFileSync(host, '{}\n');
  return host;
}

beforeEach(() => {
  // Native, as the proof's own realpath: a short (8.3) temp name comes back long.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-share-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('wslTranscriptSharePath', () => {
  it('names the file on the pane\'s distro share, as wslPathToHost does', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const B = '\\';
    expect(wslTranscriptSharePath(own, SID, DEV, { platform: 'win32' })).toEqual({
      ok: true,
      share: `${B}${B}wsl$${B}Ubuntu`,
      file: `${B}${B}wsl$${B}Ubuntu${B}home${B}dev${B}.claude${B}projects${B}-repo${B}${SID}.jsonl`,
    });
  });

  it('takes the distro and the home from the pane\'s target only', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    expect(wslTranscriptSharePath(own, SID, { distribution: 'Debian', user: 'dev' }, opts))
      .toMatchObject({ ok: true, file: path.join(shares('Debian'), 'home', 'dev', '.claude', 'projects', '-repo', `${SID}.jsonl`) });
    expect(wslTranscriptSharePath(`/root/.claude/projects/-r/${SID}.jsonl`, SID, { distribution: 'Ubuntu', user: 'root' }, opts).ok).toBe(true);
    // Another user's home, root's, or a target with no valid distro or user.
    for (const [p, target] of [
      [own, { distribution: 'Ubuntu', user: 'other' }],
      [`/root/.claude/projects/-repo/${SID}.jsonl`, DEV],
      [own, { user: 'dev' }],
      [own, { distribution: '..', user: 'dev' }],
      [own, { distribution: 'Ubuntu.', user: 'dev' }],
      [own, { distribution: 'Ubuntu' }],
      [own, undefined],
    ] as const) {
      expect(wslTranscriptSharePath(p, SID, target, opts).ok, JSON.stringify(target)).toBe(false);
    }
  });

  it('refuses anything but this session\'s file directly in a project folder, or a name Windows reads differently', () => {
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
      expect(wslTranscriptSharePath(p, SID, DEV, opts).ok, p).toBe(false);
    }
    // The session id must be the file's.
    expect(wslTranscriptSharePath(`/home/dev/.claude/projects/-repo/${SID}.jsonl`, '0a1b2c3d-0000-4000-8000-000000000002', DEV, opts).ok).toBe(false);
  });

  it('applies on Windows only', () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    for (const platform of ['linux', 'darwin'] as const) {
      expect(wslTranscriptSharePath(own, SID, DEV, { ...opts, platform }).ok).toBe(false);
    }
  });
});

describe('proveWslTranscriptPath', () => {
  it('proves the pane user\'s own transcript', async () => {
    const own = `/home/dev/.claude/projects/-home-dev-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own);
    expect(await resolve(own, SID, DEV)).toEqual({ ok: true, hostPath: host });
    const rootOwn = `/root/.claude/projects/-root-repo/${SID}.jsonl`;
    const rootHost = place('Ubuntu', rootOwn);
    expect(await resolve(rootOwn, SID, { distribution: 'Ubuntu', user: 'root' })).toEqual({ ok: true, hostPath: rootHost });
  });

  it('serves a file not written yet as pending, only inside a real project folder', async () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own, true);
    expect(await resolve(own, SID, DEV)).toEqual({ ok: true, hostPath: host, pending: true });
    // No project folder: it cannot be followed, and the reason says so.
    expect(await resolve(`/home/dev/.claude/projects/-none/${SID}.jsonl`, SID, DEV)).toEqual({ ok: false, reason: UNREACHABLE });
    // A folder at the file's name is not a transcript.
    fs.mkdirSync(host);
    expect((await resolve(own, SID, DEV)).ok).toBe(false);
  });

  it('refuses a project folder linked out of the projects root', async () => {
    const outside = path.join(shares('Ubuntu'), 'etc');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, `${SID}.jsonl`), '{}\n');
    const projects = path.join(shares('Ubuntu'), 'home', 'dev', '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    // A junction needs no privilege on Windows; elsewhere it is a directory link.
    fs.symlinkSync(outside, path.join(projects, '-escape'), 'junction');
    expect(await resolve(`/home/dev/.claude/projects/-escape/${SID}.jsonl`, SID, DEV))
      .toEqual({ ok: false, reason: 'outside the Claude projects root' });
  });

  it.skipIf(!canSymlink)('refuses a transcript that is a link, wherever it points', async () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    const host = place('Ubuntu', own, true);
    const secret = path.join(shares('Ubuntu'), 'secret');
    fs.writeFileSync(secret, 'x');
    fs.symlinkSync(secret, host, 'file');
    expect((await resolve(own, SID, DEV)).ok).toBe(false);
    fs.unlinkSync(host);
    const sibling = place('Ubuntu', '/home/dev/.claude/projects/-repo/other.jsonl');
    fs.symlinkSync(sibling, host, 'file');
    expect((await resolve(own, SID, DEV)).ok).toBe(false);
  });

  it('names a link the share cannot follow as unreachable, not unreadable', async () => {
    // What the share answers for a Linux link: EISDIR on the link itself,
    // ENOENT for a path through one (a dotfiles-linked ~/.claude).
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const linked: WslShareFs = {
      lstat: () => Promise.reject(fail('EISDIR')),
      realpath: () => Promise.reject(fail('EISDIR')),
      stat: () => Promise.reject(fail('EISDIR')),
    };
    const through: WslShareFs = {
      lstat: () => Promise.reject(fail('ENOENT')),
      realpath: () => Promise.reject(fail('ENOENT')),
      stat: () => Promise.reject(fail('ENOENT')),
    };
    const busy: WslShareFs = { ...through, lstat: () => Promise.reject(fail('EBUSY')) };
    const at = { file: '\\\\wsl$\\Ubuntu\\home\\dev\\.claude\\projects\\-r\\x.jsonl', share: '\\\\wsl$\\Ubuntu' };
    expect(await proveWslTranscriptPath(at, linked)).toEqual({ ok: false, reason: UNREACHABLE });
    expect(await proveWslTranscriptPath(at, through)).toEqual({ ok: false, reason: UNREACHABLE });
    // A share that did not answer says nothing about the path: transient.
    expect(await proveWslTranscriptPath(at, busy)).toEqual({ ok: false, reason: 'unreadable', transient: true });
  });

  it('refuses an entry lstat found that realpath cannot follow, rather than call it not written yet', async () => {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const file = { isFile: () => true, isDirectory: () => false } as fs.Stats;
    const dir = { isFile: () => false, isDirectory: () => true } as fs.Stats;
    const vanishing: WslShareFs = {
      lstat: () => Promise.resolve(file),
      // realpath of the file fails as missing; the folder would still prove fine.
      realpath: (p) => (p.endsWith('.jsonl') ? Promise.reject(fail('ENOENT')) : Promise.resolve(p)),
      stat: () => Promise.resolve(dir),
    };
    const at = { file: '\\\\wsl$\\Ubuntu\\home\\dev\\.claude\\projects\\-r\\x.jsonl', share: '\\\\wsl$\\Ubuntu' };
    expect(await proveWslTranscriptPath(at, vanishing)).toEqual({ ok: false, reason: UNREACHABLE });
  });

  // The proof runs on Windows only. macOS's realpath does not promise the
  // on-disk spelling, so a case-insensitive APFS volume cannot stand in here.
  it.skipIf(process.platform === 'darwin')('refuses a case variant of the real path: Linux names are case-sensitive', async () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    expect((await resolve(`/home/dev/.claude/projects/-Repo/${SID}.jsonl`, SID, DEV)).ok).toBe(false);
    // Nor a variant of a project folder that exists, for a file not written yet.
    fs.unlinkSync(path.join(shares('Ubuntu'), 'home', 'dev', '.claude', 'projects', '-repo', `${SID}.jsonl`));
    expect((await resolve(`/home/dev/.claude/projects/-REPO/${SID}.jsonl`, SID, DEV)).ok).toBe(false);
    expect(await resolve(own, SID, DEV)).toMatchObject({ ok: true, pending: true });
  });

  it.runIf(process.platform === 'win32')('accepts the share named in another case, as Windows matches it', async () => {
    const own = `/home/dev/.claude/projects/-repo/${SID}.jsonl`;
    place('Ubuntu', own);
    const upper = (distro: string) => shares(distro).toUpperCase();
    expect((await resolve(own, SID, DEV, { ...opts, shareRoot: upper })).ok).toBe(true);
  });
});

describe('sameSharePath', () => {
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
  });
});

describe('keepOwnWslTranscriptPath', () => {
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
});
