// Sending files to another PC's pane is all or nothing: every file is
// uploaded first, and only then are the host's paths typed, in one write.
import { describe, expect, it, vi } from 'vitest';
import { sendFilesToRemote, type RemoteSendFile } from '../remoteFileSend';
import type { RemoteUploadResult } from '../RemoteHostClient';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const hostPath = (n: number) => `/Users/o/.wmux/uploads/phone/photo-2026-10-24T01-02-03-456Z-0000000${n}.png`;
const files = (n: number): RemoteSendFile[] => Array.from({ length: n }, (_, i) => ({ name: `shot${i}.png`, bytes: PNG }));
const target = { allowInput: true, allowUpload: true, generalFileUpload: true, bracketed: false };

function deps(answers: RemoteUploadResult[], write: () => Promise<void> = async () => undefined) {
  const upload = vi.fn(async () => answers.shift() ?? { ok: false as const, status: 500, error: '' });
  return { upload, write: vi.fn(write), sleep: vi.fn(async () => undefined) };
}

describe('sendFilesToRemote', () => {
  it('types nothing when the 3rd of 4 uploads is refused as too large', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }, { ok: false, status: 413, error: 'payload too large' }]);
    expect(await sendFilesToRemote(files(4), target, d)).toEqual({ ok: false, reason: 'too-large' });
    expect(d.upload).toHaveBeenCalledTimes(3);
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a prompt waiting on the pane (409) comes back as prompt-active', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }], async () => { throw new Error('terminal-prompt-active'); });
    expect(await sendFilesToRemote(files(1), target, d)).toEqual({ ok: false, reason: 'prompt-active' });
  });

  it('types every path in one bracketed write, with no Enter', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }]);
    expect(await sendFilesToRemote(files(2), { ...target, bracketed: true }, d)).toEqual({ ok: true, count: 2 });
    expect(d.write).toHaveBeenCalledWith(`\x1b[200~${hostPath(1)} ${hostPath(2)}\x1b[201~`);
  });

  it('refuses a PDF without a request when the host takes photos only', async () => {
    const d = deps([]);
    const r = await sendFilesToRemote([{ name: 'report.pdf', bytes: PDF }], { ...target, generalFileUpload: false }, d);
    expect(r).toEqual({ ok: false, reason: 'photos-only' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('sends a PDF to /api/upload-file with its extension, and a PNG to /api/upload', async () => {
    const d = deps([{ ok: true, path: hostPath(1) }, { ok: true, path: hostPath(2) }]);
    await sendFilesToRemote([{ name: 'report.PDF', bytes: PDF }, { name: 'shot.png', bytes: PNG }], target, d);
    expect(d.upload.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['pdf', null]);
  });

  it('retries a 429 once after a pause, and maps the host\'s uploads-disabled tag', async () => {
    const busy = deps([{ ok: false, status: 429, error: 'too-many-uploads' }, { ok: true, path: hostPath(1) }]);
    expect(await sendFilesToRemote(files(1), target, busy)).toEqual({ ok: true, count: 1 });
    expect(busy.sleep).toHaveBeenCalledTimes(1);
    const off = deps([{ ok: false, status: 403, error: 'uploads-disabled: server started without --allow-upload' }]);
    expect(await sendFilesToRemote(files(1), target, off)).toEqual({ ok: false, reason: 'uploads-disabled' });
  });

  it('a read-only pane or a host known to refuse uploads sends nothing', async () => {
    const d = deps([]);
    expect(await sendFilesToRemote(files(1), { ...target, allowInput: false }, d)).toEqual({ ok: false, reason: 'read-only' });
    expect(await sendFilesToRemote(files(1), { ...target, allowUpload: false }, d)).toEqual({ ok: false, reason: 'uploads-disabled' });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('a host path that is not the upload route\'s shape is never typed', async () => {
    const d = deps([{ ok: true, path: '/tmp/x; rm -rf ~' }]);
    expect(await sendFilesToRemote(files(1), target, d)).toEqual({ ok: false, reason: 'bad-path' });
    expect(d.write).not.toHaveBeenCalled();
  });
});
