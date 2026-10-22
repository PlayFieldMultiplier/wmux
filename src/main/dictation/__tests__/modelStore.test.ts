// The dictation model's download: fetched only when asked, every file
// checked against its pinned size and SHA-256 before it is kept, and
// checked again before it is loaded.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DICTATION_MODEL, DICTATION_MODEL_BYTES, dictationModelUrl, isDictationModelHost, type DictationModelState } from '../../../shared/dictation';
import { DictationModelStore } from '../modelStore';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const CONTENT: Record<string, Buffer> = {
  'tokenizer.json': Buffer.from(JSON.stringify({ model: { vocab: { a: 0 } } })),
  'generation_config.json': Buffer.from(JSON.stringify({ suppress_tokens: [1, 2], begin_suppress_tokens: [220, 50257] })),
  'onnx/encoder_model_quantized.onnx': Buffer.alloc(3000, 1),
  'onnx/decoder_model_merged_quantized.onnx': Buffer.alloc(5000, 2),
};
const FILES = Object.entries(CONTENT).map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) }));

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-dictation-'));
  fs.writeFileSync(path.join(dir, 'ort.wasm'), Buffer.from([0, 97, 115, 109]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A server that answers each file's URL with `body(path)` in two chunks. */
function server(body: (p: string) => Buffer | null = (p) => CONTENT[p] ?? null, finalUrl?: string) {
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string, init: { signal: AbortSignal }) => {
    urls.push(url);
    const p = FILES.find((f) => dictationModelUrl(f) === url)?.path;
    const data = p ? body(p) : null;
    if (!data) return new Response('missing', { status: 404 });
    const half = Math.floor(data.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
        c.enqueue(new Uint8Array(data.subarray(0, half)));
        c.enqueue(new Uint8Array(data.subarray(half)));
        c.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    Object.defineProperty(res, 'url', { value: finalUrl ?? 'https://us.aws.cdn.hf.co/xet-bridge-us/abc' });
    return res;
  });
  return { fetch, urls };
}

const store = (fetch: ReturnType<typeof server>['fetch'], onState?: (s: DictationModelState) => void) =>
  new DictationModelStore({ dataDir: dir, fetch, wasmPath: () => path.join(dir, 'ort.wasm'), files: FILES, ...(onState ? { onState } : {}) });

describe('DictationModelStore', () => {
  it('pins the real model: one revision, its files from huggingface.co, about 80 MB', () => {
    expect(DICTATION_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(DICTATION_MODEL.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(dictationModelUrl(DICTATION_MODEL.files[0])).toBe(`https://huggingface.co/onnx-community/whisper-base/resolve/${DICTATION_MODEL.revision}/generation_config.json`);
    expect(Math.round(DICTATION_MODEL_BYTES / 1e6)).toBe(79);
    // Only what the engine reads.
    expect(DICTATION_MODEL.files.map((f) => f.path).sort()).toEqual(['generation_config.json', 'onnx/decoder_model_merged_quantized.onnx', 'onnx/encoder_model_quantized.onnx', 'tokenizer.json']);
  });

  it('fetches nothing until asked, then keeps every verified file and reads ready', async () => {
    const s = server();
    const states: DictationModelState[] = [];
    const m = store(s.fetch, (x) => states.push(x));
    expect(m.status()).toEqual({ state: 'absent' });
    expect(s.fetch).not.toHaveBeenCalled();
    expect(await m.download()).toEqual({ state: 'ready' });
    expect(s.urls).toHaveLength(FILES.length);
    for (const f of FILES) expect(fs.readFileSync(path.join(m.dir(), f.path))).toEqual(CONTENT[f.path]);
    expect(states[0]).toMatchObject({ state: 'downloading', received: 0 });
    expect(states.at(-1)).toEqual({ state: 'ready' });
    // A second store over the same folder starts ready, and a second download fetches nothing.
    const again = store(s.fetch);
    expect(again.status()).toEqual({ state: 'ready' });
    await again.download();
    expect(s.urls).toHaveLength(FILES.length);
  });

  it('a file that does not match its pinned hash is not kept, and the download fails', async () => {
    const s = server((p) => (p === 'onnx/encoder_model_quantized.onnx' ? Buffer.alloc(3000, 9) : CONTENT[p]));
    const m = store(s.fetch);
    const result = await m.download();
    expect(result).toMatchObject({ state: 'failed' });
    expect((result as { message: string }).message).toContain('does not match the pinned model');
    const encoder = path.join(m.dir(), 'onnx/encoder_model_quantized.onnx');
    expect(fs.existsSync(encoder)).toBe(false);
    expect(fs.existsSync(`${encoder}.part`)).toBe(false);
    expect(await m.loadAssets()).toBeNull();
  });

  it('a file larger than pinned is cut off, and an HTTP error fails the download', async () => {
    const big = store(server((p) => Buffer.concat([CONTENT[p], Buffer.from('extra')])).fetch);
    expect(await big.download()).toMatchObject({ state: 'failed', message: expect.stringContaining('larger than') });
    const missing = store(server(() => null).fetch);
    expect(await missing.download()).toMatchObject({ state: 'failed', message: expect.stringContaining('HTTP 404') });
  });

  it('a file redirected anywhere but Hugging Face or its CDN is refused', async () => {
    expect(isDictationModelHost('huggingface.co')).toBe(true);
    expect(isDictationModelHost('us.aws.cdn.hf.co')).toBe(true);
    expect(isDictationModelHost('cdn.hf.co.evil.example')).toBe(false);
    expect(isDictationModelHost('evilhf.co')).toBe(false);
    const m = store(server(undefined, 'https://mirror.example.com/x').fetch);
    expect(await m.download()).toMatchObject({ state: 'failed', message: expect.stringContaining('redirected to mirror.example.com') });
  });

  it('a cancelled download leaves the model absent', async () => {
    const s = server();
    const m = store(s.fetch, (x) => {
      if (x.state === 'downloading') m.cancel();
    });
    expect(await m.download()).toEqual({ state: 'absent' });
  });

  it('loads the engine\'s assets once verified, and refuses a file changed on disk since', async () => {
    const m = store(server().fetch);
    await m.download();
    const assets = await m.loadAssets();
    expect(assets?.suppress).toEqual([1, 2]);
    expect(assets?.beginSuppress).toEqual([220, 50257]);
    expect(assets?.encoder.length).toBe(3000);
    expect([...(assets?.wasm ?? [])]).toEqual([0, 97, 115, 109]);
    // A later process (nothing verified yet) finds the decoder swapped.
    const decoder = path.join(m.dir(), 'onnx/decoder_model_merged_quantized.onnx');
    fs.writeFileSync(decoder, Buffer.alloc(5000, 7));
    const later = store(server().fetch);
    expect(later.status()).toEqual({ state: 'ready' });
    expect(await later.loadAssets()).toBeNull();
    expect(later.status()).toEqual({ state: 'absent' });
    expect(fs.existsSync(decoder)).toBe(false);
  });
});
