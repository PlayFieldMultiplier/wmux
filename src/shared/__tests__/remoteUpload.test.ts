// @wmux-lane unit — 'win32' here is a host OS value under test, not this machine's platform.
// The path a host's upload route answers with is typed at a shell prompt on
// that host, so only the exact shape the route produces, in the host's own
// path syntax and in characters that need no shell interpretation, is typed.
import { describe, expect, it } from 'vitest';
import { remoteUploadPathText } from '../remoteUpload';

const NAME = 'photo-2026-10-24T01-02-03-456Z-0123abcd.png';
const POSIX = `/Users/o/.wmux/uploads/phone/${NAME}`;
const WIN = `C:\\Users\\o\\.wmux\\uploads\\phone\\${NAME}`;
const mac = { hostPlatform: 'darwin' };
const win = { hostPlatform: 'win32' };

describe('remoteUploadPathText', () => {
  it('always single-quotes a POSIX upload path', () => {
    expect(remoteUploadPathText(POSIX, mac)).toEqual({ ok: true, text: `'${POSIX}'` });
    expect(remoteUploadPathText(`/Users/Jane Doe/.wmux/uploads/phone/${NAME}`, mac)).toEqual({ ok: true, text: `'/Users/Jane Doe/.wmux/uploads/phone/${NAME}'` });
  });

  it('refuses $(, a quote, a newline and a paste-end escape anywhere in the path', () => {
    for (const dir of ['/tmp/$(touch x)', "/tmp/it's", '/tmp/a\nb', '/tmp/\x1b[201~echo x']) {
      expect(remoteUploadPathText(`${dir}/.wmux/uploads/phone/${NAME}`, mac).ok).toBe(false);
    }
  });

  it('refuses anything but the upload route\'s own shape', () => {
    for (const p of [
      '/tmp/other.png',
      `/tmp/${NAME}`,
      `/home/o/uploads/other/${NAME}`,
      '/Users/o/.wmux/uploads/phone/photo-vacation.jpg',
      `relative/uploads/phone/${NAME}`,
      `/a/../uploads/phone/${NAME}`,
      `/a/./uploads/phone/${NAME}`,
      `/a//uploads/phone/${NAME}`,
      `//server/share/uploads/phone/${NAME}`,
      `/${'a/'.repeat(260)}uploads/phone/${NAME}`,
      42,
    ]) {
      expect(remoteUploadPathText(p, mac)).toEqual({ ok: false, reason: 'bad-path' });
    }
  });

  it('takes the syntax from the host\'s OS, not the path, and types nothing for an unknown OS', () => {
    expect(remoteUploadPathText(WIN, mac)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(POSIX, win)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(POSIX, {})).toEqual({ ok: false, reason: 'host-unknown' });
  });

  it('always double-quotes a Windows path, and refuses what cmd or PowerShell would read', () => {
    expect(remoteUploadPathText(WIN, win)).toEqual({ ok: true, text: `"${WIN}"` });
    const spaced = `C:\\Users\\Jane Doe\\.wmux\\uploads\\phone\\${NAME}`;
    expect(remoteUploadPathText(spaced, win)).toEqual({ ok: true, text: `"${spaced}"` });
    for (const user of ["O'Neil", 'a&b', '%USERNAME%', 'hi!', '$env']) {
      expect(remoteUploadPathText(`C:\\Users\\${user}\\.wmux\\uploads\\phone\\${NAME}`, win)).toEqual({ ok: false, reason: 'unquotable' });
    }
    expect(remoteUploadPathText(`C:\\a\\..\\uploads\\phone\\${NAME}`, win)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(`\\\\server\\share\\uploads\\phone\\${NAME}`, win)).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('maps a Windows path to /mnt for a WSL pane, and checks the result again', () => {
    expect(remoteUploadPathText(WIN, { ...win, wsl: true })).toEqual({ ok: true, text: `'/mnt/c/Users/o/.wmux/uploads/phone/${NAME}'` });
    // A colon is fine for cmd inside quotes, not in the POSIX character set the mapped path must meet.
    const colon = `C:\\a:b\\.wmux\\uploads\\phone\\${NAME}`;
    expect(remoteUploadPathText(colon, win).ok).toBe(true);
    expect(remoteUploadPathText(colon, { ...win, wsl: true })).toEqual({ ok: false, reason: 'unquotable' });
  });
});
