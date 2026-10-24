// Sending files to another PC's pane is all or nothing: every file is
// uploaded first, and only then are the host's paths handed back to type.
import { describe, expect, it, vi } from 'vitest';
import { remoteWriteFailure, uploadFilesForRemote, type RemoteSendFile } from '../remoteFileSend';
import { RemoteAuthRejectedError, type RemoteUploadResult } from '../RemoteHostClient';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const hostPath = (n: number) => `/Users/o/.wmux/uploads/phone/photo-2026-10-24T01-02-03-456Z-0000000${n}.png`;
const files = (n: number): RemoteSendFile[] => Array.from({ length: n }, (_, i) => ({ name: `shot${i}.png`, bytes: PNG }));
const target = { allowInput: true, allowUpload: true, generalFileUpload: true, hostPlatform: 'darwin' };

function deps(answers: RemoteUploadResult[], signal?: AbortSignal) {
  const upload = vi.fn(async () => answers.shift() ?? { ok: false as const, status: 500, error: '' });
  return { upload, signal, sleep: vi.fn(async () => undefined) };
}

describe('uploadFilesForRemote', () => {
  it('hands back nothing when the 3rd of 4 uploads is refused as too large', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }, { ok: false, status: 413, error: 'payload too large' }]);
    expect(await uploadFilesForRemote(files(4), target, d)).toEqual({ ok: false, reason: 'too-large' });
    expect(d.upload).toHaveBeenCalledTimes(3);
  });

  it('hands back every path quoted, in one text', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }]);
    expect(await uploadFilesForRemote(files(2), target, d)).toEqual({ ok: true, count: 2, text: `'${hostPath(1)}' '${hostPath(2)}'` });
  });

  it('refuses a PDF without a request when the host takes photos only', async () => {
    const d = deps([]);
    const r = await uploadFilesForRemote([{ name: 'report.pdf', bytes: PDF }], { ...target, generalFileUpload: false }, d);
    expect(r).toEqual({ ok: false, reason: 'photos-only' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('sends a PDF to /api/upload-file with its extension, and a PNG to /api/upload', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }]);
    await uploadFilesForRemote([{ name: 'report.PDF', bytes: PDF }, { name: 'shot.png', bytes: PNG }], target, d);
    expect(d.upload.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['pdf', null]);
  });

  it('retries a 429 once after a pause, and maps the host\'s uploads-disabled tag', async () => {
    const busy = deps([{ ok: false, status: 429, error: 'too-many-uploads' }, { ok: true, path: hostPath(1) }]);
    expect((await uploadFilesForRemote(files(1), target, busy)).ok).toBe(true);
    expect(busy.sleep).toHaveBeenCalledTimes(1);
    const off = deps([{ ok: false, status: 403, error: 'uploads-disabled: server started without --allow-upload' }]);
    expect(await uploadFilesForRemote(files(1), target, off)).toEqual({ ok: false, reason: 'uploads-disabled' });
  });

  it('unknown grants count as refused, and nothing is sent', async () => {
    const d = deps([]);
    expect(await uploadFilesForRemote(files(1), { ...target, allowInput: undefined }, d)).toEqual({ ok: false, reason: 'read-only' });
    expect(await uploadFilesForRemote(files(1), { ...target, allowUpload: undefined }, d)).toEqual({ ok: false, reason: 'uploads-disabled' });
    expect(await uploadFilesForRemote(files(1), { ...target, hostPlatform: undefined }, d)).toEqual({ ok: false, reason: 'host-unknown' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('a host path that is not the upload route\'s shape is never handed back', async () => {
    const d = deps([{ ok: true, path: '/tmp/a; b' }]);
    expect(await uploadFilesForRemote(files(1), target, d)).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('a detached pane stops the send before the next file', async () => {
    const controller = new AbortController();
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }], controller.signal);
    d.upload.mockImplementationOnce(async () => { controller.abort(); return { ok: true, path: hostPath(1) }; });
    expect(await uploadFilesForRemote(files(2), target, d)).toEqual({ ok: false, reason: 'pane-changed' });
    expect(d.upload).toHaveBeenCalledTimes(1);
  });
});

describe('remoteWriteFailure', () => {
  it('says applied-nothing only when the host answered, and maybe-applied for a transport failure', () => {
    expect(remoteWriteFailure(new Error('terminal-prompt-active'))).toBe('prompt-active');
    expect(remoteWriteFailure(new RemoteAuthRejectedError('write'))).toBe('auth');
    expect(remoteWriteFailure(new Error('write failed: HTTP 500'))).toBe('failed');
    expect(remoteWriteFailure(new TypeError('fetch failed'))).toBe('unknown');
    expect(remoteWriteFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('unknown');
  });
});
