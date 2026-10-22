// The speech engine's worker: onnxruntime-web's WebAssembly backend running
// Whisper (./whisper.ts) off the UI thread. It gets the model and the
// runtime's .wasm as bytes (main reads them from the app's data and
// resources), so it fetches nothing.

import * as ort from 'onnxruntime-web/wasm';
import { transcribe, WhisperTokenizer, type DictationLanguage, type WhisperSessions } from './whisper';
import type { DictationAssets } from '../../shared/dictation';

export type WorkerRequest =
  | { type: 'init'; assets: DictationAssets }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: DictationLanguage | 'auto' };

export type WorkerReply =
  | { type: 'ready' }
  | { type: 'text'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

let engine: { sessions: WhisperSessions; tokenizer: WhisperTokenizer; suppress: number[]; beginSuppress: number[] } | null = null;

const post = (reply: WorkerReply) => (self as unknown as Worker).postMessage(reply);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'init') {
      ort.env.wasm.wasmBinary = req.assets.wasm;
      // No SharedArrayBuffer here (the page is not cross-origin isolated).
      ort.env.wasm.numThreads = 1;
      const encoder = await ort.InferenceSession.create(req.assets.encoder);
      const decoder = await ort.InferenceSession.create(req.assets.decoder);
      engine = { sessions: { encoder, decoder }, tokenizer: new WhisperTokenizer(req.assets.tokenizer), suppress: req.assets.suppress, beginSuppress: req.assets.beginSuppress };
      post({ type: 'ready' });
      return;
    }
    if (!engine) throw new Error('the speech engine is not loaded');
    const text = await transcribe(ort, engine.sessions, engine.tokenizer, req.audio, { language: req.language, suppress: engine.suppress, beginSuppress: engine.beginSuppress });
    post({ type: 'text', id: req.id, text });
  } catch (err) {
    post({ type: 'error', ...(req.type === 'transcribe' ? { id: req.id } : {}), message: err instanceof Error ? err.message : String(err) });
  }
};
