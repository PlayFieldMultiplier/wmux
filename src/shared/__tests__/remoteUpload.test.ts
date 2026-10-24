// The path a host's upload route answers with is typed into a live shell on
// that host, so only the exact shape the route produces, in characters that
// need no shell interpretation, is ever typed.
import { describe, expect, it } from 'vitest';
import { remoteUploadPathText } from '../remoteUpload';

const NAME = 'photo-2026-10-24T01-02-03-456Z-0123abcd.png';
const POSIX = `/Users/o/.wmux/uploads/phone/${NAME}`;
const WIN = `C:\\Users\\o\\.wmux\\uploads\\phone\\${NAME}`;

describe('remoteUploadPathText', () => {
  it('types a POSIX upload path as is, and single-quotes one with a space', () => {
    expect(remoteUploadPathText(POSIX)).toEqual({ ok: true, text: POSIX });
    expect(remoteUploadPathText(`/Users/Jane Doe/.wmux/uploads/phone/${NAME}`)).toEqual({ ok: true, text: `'/Users/Jane Doe/.wmux/uploads/phone/${NAME}'` });
  });

  it('refuses $(, a quote, a newline and a paste-end escape anywhere in the path', () => {
    for (const dir of ['/tmp/$(touch x)', "/tmp/it's", '/tmp/a\nb', '/tmp/\x1b[201~echo pwned']) {
      expect(remoteUploadPathText(`${dir}/.wmux/uploads/phone/${NAME}`).ok).toBe(false);
    }
  });

  it('refuses anything but the upload route\'s own shape', () => {
    expect(remoteUploadPathText('/tmp/evil.png')).toEqual({ ok: false, reason: 'bad-path' });
    // The right name outside the uploads folder is still not the route's answer.
    expect(remoteUploadPathText(`/tmp/${NAME}`)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(`/home/o/uploads/other/${NAME}`)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText('/Users/o/.wmux/uploads/phone/photo-vacation.jpg')).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(`relative/uploads/phone/${NAME}`)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(`/${'a/'.repeat(260)}uploads/phone/${NAME}`)).toEqual({ ok: false, reason: 'bad-path' });
    expect(remoteUploadPathText(42)).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('always double-quotes a Windows path, and refuses one with an apostrophe or an ampersand', () => {
    expect(remoteUploadPathText(WIN)).toEqual({ ok: true, text: `"${WIN}"` });
    const spaced = `C:\\Users\\Jane Doe\\.wmux\\uploads\\phone\\${NAME}`;
    expect(remoteUploadPathText(spaced)).toEqual({ ok: true, text: `"${spaced}"` });
    expect(remoteUploadPathText(`C:\\Users\\O'Neil\\.wmux\\uploads\\phone\\${NAME}`)).toEqual({ ok: false, reason: 'unquotable' });
    expect(remoteUploadPathText(`C:\\Users\\a&b\\.wmux\\uploads\\phone\\${NAME}`)).toEqual({ ok: false, reason: 'unquotable' });
  });

  it('maps a Windows path to /mnt for a WSL pane', () => {
    expect(remoteUploadPathText(WIN, { wsl: true })).toEqual({ ok: true, text: `/mnt/c/Users/o/.wmux/uploads/phone/${NAME}` });
  });
});
