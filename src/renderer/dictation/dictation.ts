// Voice dictation, one at a time across the app: the model's consent and
// download, the recording, and its transcription into the input that asked
// for it (a composer, or a terminal pane as a bracketed paste). Components
// read it with useDictation and act through the functions below.

import { useSyncExternalStore } from 'react';
import { getLocale } from '../i18n';
import type { DictationModelState } from '../../shared/dictation';
import { startRecording, type Recording } from './recorder';
import { dictationLanguageFor } from './whisper';
import type { WorkerReply, WorkerRequest } from './whisper.worker';
import WhisperWorker from './whisper.worker?worker';

export type DictationPhase =
  /** Nothing running. */
  | 'idle'
  /** The model is not on this computer: the consent is showing. */
  | 'consent'
  | 'downloading'
  /** The engine is starting (the model loads into the worker). */
  | 'loading'
  | 'recording'
  | 'transcribing';

export interface DictationState {
  phase: DictationPhase;
  /** Whose dictation it is (a composer's or pane's key), when not idle. */
  target: string | null;
  model: DictationModelState;
  /** When the recording started (the indicator's clock). */
  startedAt: number | null;
  /** The last failure, said once by whoever shows it. */
  error: string | null;
}

/** Where the text goes once it is ready. */
export type DictationDeliver = (text: string) => void;

const IDLE_ENGINE_MS = 5 * 60_000;

let state: DictationState = { phase: 'idle', target: null, model: { state: 'absent' }, startedAt: null, error: null };
const listeners = new Set<() => void>();
let deliver: DictationDeliver | null = null;
let recording: Recording | null = null;
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
let modelWatch: (() => void) | null = null;

function set(patch: Partial<DictationState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function api() {
  return window.electronAPI.dictation;
}

function watchModel(): void {
  if (modelWatch) return;
  modelWatch = api().onState((model) => {
    set({ model, ...(state.phase === 'downloading' && model.state !== 'downloading' ? { phase: 'idle', target: null } : {}) });
  });
  void api().status().then((model) => set({ model }));
}

export function useDictation(): DictationState {
  watchModel();
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => state);
}

export function getDictationState(): DictationState {
  return state;
}

function fail(message: string): void {
  set({ phase: 'idle', target: null, startedAt: null, error: message });
}

/** Starts dictating for `target`, or stops it when `target` is already
 *  recording (one key or button toggles). The model's consent shows first
 *  when it is not on this computer. */
export async function toggleDictation(target: string, onText: DictationDeliver): Promise<void> {
  watchModel();
  if (state.phase === 'recording' && state.target === target) return stopDictation();
  if (state.phase !== 'idle') return;
  set({ error: null });
  const model = await api().status();
  set({ model });
  if (model.state !== 'ready') {
    set({ phase: model.state === 'downloading' ? 'downloading' : 'consent', target });
    return;
  }
  if ((await api().micAccess()) !== 'granted') return fail('mic-denied');
  deliver = onText;
  set({ phase: 'loading', target });
  try {
    await ensureWorker();
    recording = await startRecording(() => void stopDictation());
  } catch (err) {
    deliver = null;
    return fail(err instanceof Error ? err.message : String(err));
  }
  set({ phase: 'recording', startedAt: Date.now() });
}

/** The owner agreed to the download in the consent: fetch the model. */
export async function acceptModelDownload(): Promise<void> {
  if (state.phase !== 'consent') return;
  set({ phase: 'downloading' });
  const model = await api().download();
  set({ model, phase: 'idle', target: null });
  if (model.state === 'failed') set({ error: model.message });
}

export function declineModelDownload(): void {
  if (state.phase === 'consent') set({ phase: 'idle', target: null });
}

export function cancelModelDownload(): void {
  void api().cancel();
}

/** Ends the recording and writes its text to the input that asked. */
export async function stopDictation(): Promise<void> {
  if (state.phase !== 'recording' || !recording) return;
  const rec = recording;
  recording = null;
  set({ phase: 'transcribing', startedAt: null });
  try {
    const audio = await rec.stop();
    const text = await transcribeInWorker(audio);
    const to = deliver;
    deliver = null;
    set({ phase: 'idle', target: null });
    if (text && to) to(text);
  } catch (err) {
    deliver = null;
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Drops the recording; nothing is written. */
export function cancelDictation(): void {
  if (state.phase === 'recording' || state.phase === 'loading') {
    recording?.cancel();
    recording = null;
    deliver = null;
    set({ phase: 'idle', target: null, startedAt: null });
  } else if (state.phase === 'consent') {
    declineModelDownload();
  }
}

export function clearDictationError(): void {
  if (state.error) set({ error: null });
}

function ensureWorker(): Promise<void> {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    const res = await api().assets();
    if (!res.ok) {
      set({ model: res.state });
      throw new Error(res.state.state === 'failed' ? res.state.message : 'the speech model is not on this computer');
    }
    const w = new WhisperWorker();
    await new Promise<void>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<WorkerReply>) => {
        const reply = e.data;
        if (reply.type === 'ready') return resolve();
        if (reply.type === 'error' && reply.id === undefined) return reject(new Error(reply.message));
        const p = reply.id !== undefined ? pending.get(reply.id) : undefined;
        if (!p || reply.id === undefined) return;
        pending.delete(reply.id);
        if (reply.type === 'text') p.resolve(reply.text);
        else p.reject(new Error(reply.message));
      };
      w.onerror = (e) => reject(new Error(e.message || 'the speech engine stopped'));
      const { assets } = res;
      const init: WorkerRequest = { type: 'init', assets };
      w.postMessage(init, [assets.encoder.buffer, assets.decoder.buffer, assets.wasm.buffer] as Transferable[]);
    });
    worker = w;
  })();
  workerReady.catch(() => {
    workerReady = null;
  });
  return workerReady;
}

async function transcribeInWorker(audio: Float32Array): Promise<string> {
  await ensureWorker();
  const w = worker;
  if (!w) throw new Error('the speech engine is not running');
  if (idleTimer) clearTimeout(idleTimer);
  const id = nextId++;
  const text = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const req: WorkerRequest = { type: 'transcribe', id, audio, language: dictationLanguageFor(getLocale()) };
    w.postMessage(req, [audio.buffer]);
  });
  // The engine holds the model in memory: let it go when dictation rests.
  idleTimer = setTimeout(() => {
    worker?.terminate();
    worker = null;
    workerReady = null;
  }, IDLE_ENGINE_MS);
  return text.trim();
}
