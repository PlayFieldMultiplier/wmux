// RemoteHostClient.upload: the operator token over the host's own origin,
// never a redirect, the route chosen by the caller, and a refusal handed back
// with its status and tag rather than thrown.
import { describe, expect, it, vi } from 'vitest';
import { RemoteHostClient } from '../RemoteHostClient';
import type { RemoteHost } from '../../../shared/remoteHosts';

const host = (origin = 'https://desk.tail1.ts.net:9600'): RemoteHost => ({ id: 'h1', label: 'desk', origin, token: 'tok', addedAt: 1 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('RemoteHostClient.upload', () => {
  it('posts a photo to /api/upload and a file to /api/upload-file with its extension', async () => {
    const fetchImpl = vi.fn(async () => json(201, { path: '/p', expiresAt: 1 }));
    const client = new RemoteHostClient(host(), fetchImpl as unknown as typeof fetch);
    expect(await client.upload(new Uint8Array([1]), null)).toEqual({ ok: true, path: '/p' });
    await client.upload(new Uint8Array([1]), 'pdf');
    const [[photoUrl, photoInit], [fileUrl, fileInit]] = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(photoUrl).toBe('https://desk.tail1.ts.net:9600/api/upload');
    expect(fileUrl).toBe('https://desk.tail1.ts.net:9600/api/upload-file');
    expect(photoInit.redirect).toBe('error');
    expect((photoInit.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((photoInit.headers as Record<string, string>)['X-Wmux-File-Extension']).toBeUndefined();
    expect((fileInit.headers as Record<string, string>)['X-Wmux-File-Extension']).toBe('pdf');
  });

  it('hands back a refusal with its status and tag', async () => {
    const fetchImpl = vi.fn(async () => json(403, { error: 'uploads-disabled: server started without --allow-upload' }));
    const client = new RemoteHostClient(host(), fetchImpl as unknown as typeof fetch);
    expect(await client.upload(new Uint8Array([1]), null)).toEqual({
      ok: false, status: 403, error: 'uploads-disabled: server started without --allow-upload',
    });
  });

  it('never sends the token to plain http on another machine', async () => {
    const fetchImpl = vi.fn();
    const client = new RemoteHostClient(host('http://desk.lan:9600'), fetchImpl as unknown as typeof fetch);
    await expect(client.upload(new Uint8Array([1]), null)).rejects.toThrow(/HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
