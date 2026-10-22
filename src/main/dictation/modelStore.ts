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
  type DictationAssets,
  type DictationModelFile,
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
}

const PROGRESS_MS = 250;

export class DictationModelStore {
  private state: DictationModelState;
  private running: AbortController | null = null;
  /** Files whose hash was checked since this process started. */
  private readonly verified = new Set<string>();

  constructor(private readonly opts: ModelStoreOptions) {
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
    return DICTATION_MODEL.files.every((f) => {
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
      let received = DICTATION_MODEL.files.reduce((sum, f) => sum + (this.present(f) ? f.size : 0), 0);
      this.set({ state: 'downloading', received, total: DICTATION_MODEL_BYTES });
      for (const file of DICTATION_MODEL.files) {
        if (this.present(file)) continue;
        const base = received;
        await this.fetchFile(file, abort.signal, (bytes) => {
          received = base + bytes;
          this.set({ state: 'downloading', received, total: DICTATION_MODEL_BYTES });
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

  private present(file: DictationModelFile): boolean {
    try {
      return fs.statSync(path.join(this.dir(), file.path)).size === file.size;
    } catch {
      return false;
    }
  }

  private async fetchFile(file: DictationModelFile, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
    const target = path.join(this.dir(), file.path);
    const part = `${target}.part`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = await this.opts.fetch(dictationModelUrl(file), { signal });
    if (!res.ok || !res.body) throw new Error(`${file.path}: HTTP ${res.status}`);
    const hash = createHash('sha256');
    const out = fs.openSync(part, 'w');
    let bytes = 0;
    let lastReport = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
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

  /** The engine's inputs, each model file checked against its hash first.
   *  A file that changed on disk is deleted and the model reads absent. */
  loadAssets(): DictationAssets | null {
    if (!this.complete()) return null;
    const read = (file: DictationModelFile): Buffer | null => {
      const full = path.join(this.dir(), file.path);
      const data = fs.readFileSync(full);
      if (!this.verified.has(file.path)) {
        if (createHash('sha256').update(data).digest('hex') !== file.sha256) {
          fs.rmSync(full, { force: true });
          return null;
        }
        this.verified.add(file.path);
      }
      return data;
    };
    const byPath = (p: string) => DICTATION_MODEL.files.find((f) => f.path === p) as DictationModelFile;
    const encoder = read(byPath('onnx/encoder_model_quantized.onnx'));
    const decoder = read(byPath('onnx/decoder_model_merged_quantized.onnx'));
    const tokenizer = read(byPath('tokenizer.json'));
    const generation = read(byPath('generation_config.json'));
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
      wasm: fs.readFileSync(this.opts.wasmPath()),
    };
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
