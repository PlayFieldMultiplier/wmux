// The dictation model on disk: `<wmuxDir>/models/whisper-base/<revision>/`.
// Downloaded only when the owner says so (the consent in the renderer is the
// only caller of `download`), from the pinned revision; every file is
// written to a `.part`, its size and SHA-256 checked as it streams, and only
// then renamed into place. A file that does not check out is deleted and the
// download fails: nothing unverified is ever loaded. After that it works
// offline.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DICTATION_MODEL,
  DICTATION_MODEL_BYTES,
  dictationModelUrl,
  isDictationModelHost,
  type DictationAssets,
  type DictationModelState,
} from '../../shared/dictation';

export interface ModelStoreOptions {
  /** wmux's data dir (getWmuxDir()). */
  dataDir: string;
  /** Fetches a URL (Electron's net.fetch, which follows the system proxy). */
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** onnxruntime-web's .wasm as this build ships it. */
  wasmPath: () => string;
  onState?: (state: DictationModelState) => void;
  /** The files to fetch (tests pass small ones). */
  files?: readonly ModelFile[];
}

const PROGRESS_MS = 250;

interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

export class DictationModelStore {
  private state: DictationModelState;
  private running: AbortController | null = null;
  /** Files whose hash was checked since this process started. */
  private readonly verified = new Set<string>();
  private readonly files: readonly ModelFile[];
  private readonly total: number;

  constructor(private readonly opts: ModelStoreOptions) {
    this.files = opts.files ?? DICTATION_MODEL.files;
    this.total = opts.files ? opts.files.reduce((sum, f) => sum + f.size, 0) : DICTATION_MODEL_BYTES;
    this.state = this.complete() ? { state: 'ready' } : { state: 'absent' };
  }

  dir(): string {
    return path.join(this.opts.dataDir, 'models', 'whisper-base', DICTATION_MODEL.revision);
  }

  status(): DictationModelState {
    return this.state;
  }

  private set(next: DictationModelState): void {
    this.state = next;
    this.opts.onState?.(next);
  }

  /** Every file is in place at its size (its hash is checked on load). */
  private complete(): boolean {
    return this.files.every((f) => {
      try {
        return fs.statSync(path.join(this.dir(), f.path)).size === f.size;
      } catch {
        return false;
      }
    });
  }

  /** Fetches whatever is missing. One download at a time: a second call
   *  while one runs waits for it. */
  async download(): Promise<DictationModelState> {
    if (this.running) return this.waitForRun();
    if (this.complete()) {
      this.set({ state: 'ready' });
      return this.state;
    }
    const abort = new AbortController();
    this.running = abort;
    try {
      let received = this.files.reduce((sum, f) => sum + (this.present(f) ? f.size : 0), 0);
      this.set({ state: 'downloading', received, total: this.total });
      for (const file of this.files) {
        if (this.present(file)) continue;
        const base = received;
        await this.fetchFile(file, abort.signal, (bytes) => {
          received = base + bytes;
          this.set({ state: 'downloading', received, total: this.total });
        });
        received = base + file.size;
      }
      this.set({ state: 'ready' });
    } catch (err) {
      this.set(abort.signal.aborted ? { state: 'absent' } : { state: 'failed', message: describe(err) });
    } finally {
      this.running = null;
    }
    return this.state;
  }

  cancel(): void {
    this.running?.abort();
  }

  private waitForRun(): Promise<DictationModelState> {
    return new Promise((resolve) => {
      const poll = () => (this.running ? setTimeout(poll, 100) : resolve(this.state));
      poll();
    });
  }

  private present(file: ModelFile): boolean {
    try {
      return fs.statSync(path.join(this.dir(), file.path)).size === file.size;
    } catch {
      return false;
    }
  }

  private async fetchFile(file: ModelFile, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    const target = path.join(this.dir(), file.path);
    const part = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    signal.throwIfAborted();
    const res = await this.opts.fetch(dictationModelUrl(file), { signal });
    if (!res.ok || !res.body) throw new Error(`${file.path}: HTTP ${res.status}`);
    // The consent names Hugging Face and its CDN; a redirect anywhere else is refused.
    if (res.url && !isDictationModelHost(new URL(res.url).hostname)) throw new Error(`${file.path}: redirected to ${new URL(res.url).hostname}`);
    const hash = createHash('sha256');
    const out = fs.openSync(part, 'w');
    let bytes = 0;
    let lastReport = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        bytes += value.byteLength;
        if (bytes > file.size) throw new Error(`${file.path}: larger than ${file.size} bytes`);
        hash.update(value);
        fs.writeSync(out, value);
        const now = Date.now();
        if (now - lastReport >= PROGRESS_MS) {
          lastReport = now;
          progress(bytes);
        }
      }
    } catch (err) {
      fs.closeSync(out);
      fs.rmSync(part, { force: true });
      throw err;
    }
    fs.closeSync(out);
    const digest = hash.digest('hex');
    if (bytes !== file.size || digest !== file.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`${file.path}: does not match the pinned model (size ${bytes}, sha256 ${digest.slice(0, 12)}…)`);
    }
    fs.renameSync(part, target);
    this.verified.add(file.path);
  }

  /** The engine's inputs, each model file checked against its hash the
   *  first time this process reads it (streamed, so main keeps answering).
   *  A file that changed on disk is deleted and the model reads absent. */
  async loadAssets(): Promise<DictationAssets | null> {
    if (!this.complete()) return null;
    const read = async (file: ModelFile): Promise<Buffer | null> => {
      const full = path.join(this.dir(), file.path);
      if (this.verified.has(file.path)) return fs.promises.readFile(full);
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      for await (const chunk of fs.createReadStream(full)) {
        hash.update(chunk as Buffer);
        chunks.push(chunk as Buffer);
      }
      if (hash.digest('hex') !== file.sha256) {
        fs.rmSync(full, { force: true });
        return null;
      }
      this.verified.add(file.path);
      return Buffer.concat(chunks);
    };
    const byPath = (p: string) => this.files.find((f) => f.path === p) as ModelFile;
    const encoder = await read(byPath('onnx/encoder_model_quantized.onnx'));
    const decoder = await read(byPath('onnx/decoder_model_merged_quantized.onnx'));
    const tokenizer = await read(byPath('tokenizer.json'));
    const generation = await read(byPath('generation_config.json'));
    if (!encoder || !decoder || !tokenizer || !generation) {
      this.set({ state: 'absent' });
      return null;
    }
    const gen = JSON.parse(generation.toString('utf8')) as { suppress_tokens?: unknown; begin_suppress_tokens?: unknown };
    const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []);
    return {
      encoder,
      decoder,
      tokenizer: tokenizer.toString('utf8'),
      suppress: ints(gen.suppress_tokens),
      beginSuppress: ints(gen.begin_suppress_tokens),
      wasm: await fs.promises.readFile(this.opts.wasmPath()),
    };
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
