// Voice dictation, one at a time across the app: the model's consent and
// download, the recording, and its transcription into the input that asked
// for it (a composer, or a terminal pane as a bracketed paste). Components
// read it with useDictation and act through the functions below.

import { useSyncExternalStore } from 'react';
import { getLocale } from '../i18n';
import type { DictationModelState } from '../../shared/dictation';
import { startRecording, type Recording } from './recorder';
import { SAMPLE_RATE, WINDOW_SAMPLES, dictationLanguageFor } from './whisper';
import type { WorkerReply, WorkerRequest } from './whisper.worker';
// Vite's worker import; the resolver eslint uses does not know the suffix.
// eslint-disable-next-line import/no-unresolved
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
/** How long one transcription may take: a slow CPU runs a 30 s window in
 *  well under this, and a hung engine is let go rather than waited on. */
export const TRANSCRIBE_DEADLINE = { BASE_MS: 30_000, PER_WINDOW_MS: 30_000 } as const;

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
/** Moves on every start and cancel: a start whose awaits outlive a cancel
 *  (Esc, the composer going away, another start) finds it moved and undoes
 *  what it got, a just-opened recording included. */
let generation = 0;

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
  // Taken at once, so a second click or key finds it busy, and Esc or the
  // composer going away can cancel it while the awaits below run.
  const gen = ++generation;
  const stale = () => gen !== generation;
  set({ phase: 'loading', target, error: null });
  try {
    const model = await api().status();
    if (stale()) return;
    set({ model });
    if (model.state !== 'ready') {
      set({ phase: model.state === 'downloading' ? 'downloading' : 'consent' });
      return;
    }
    // The engine starts while the OS answers for the microphone.
    const engine = ensureWorker();
    engine.catch(() => undefined);
    const access = await api().micAccess();
    if (stale()) return;
    if (access !== 'granted') return fail('mic-denied');
    await engine;
    if (stale()) return;
    const rec = await startRecording(() => void stopDictation());
    if (stale()) {
      rec.cancel();
      return;
    }
    recording = rec;
    deliver = onText;
  } catch (err) {
    if (stale()) return;
    return fail(micError(err) ?? (err instanceof Error ? err.message : String(err)));
  }
  set({ phase: 'recording', startedAt: Date.now() });
}

/** `mic-denied` for the browser's refusals of the microphone (Windows and
 *  Linux say so through getUserMedia, not through the OS ask). */
export function micError(err: unknown): 'mic-denied' | null {
  const name = err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err) ? String((err as { name: unknown }).name) : '';
  return ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(name) ? 'mic-denied' : null;
}

/** The owner agreed to the download in the consent: fetch the model. */
export async function acceptModelDownload(): Promise<void> {
  if (state.phase !== 'consent') return;
  set({ phase: 'downloading' });
  const model = await api().download();
  set({ model, phase: 'idle', target: null });
  if (model.state === 'failed') set({ error: model.message });
  // The owner is about to dictate: warm the engine (it rests again after
  // IDLE_ENGINE_MS unused).
  if (model.state === 'ready') ensureWorker().catch((err: unknown) => console.warn(`[wmux:dictation] the speech engine did not start: ${String(err)}`));
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
  const gen = generation;
  set({ phase: 'transcribing', startedAt: null });
  try {
    const audio = await rec.stop();
    const seconds = audio.length / SAMPLE_RATE;
    const t0 = performance.now();
    const text = await transcribeInWorker(audio);
    // How it went, never what was said.
    console.log(`[wmux:dictation] ${seconds.toFixed(1)} s of audio → ${text.length} characters in ${Math.round(performance.now() - t0)} ms`);
    if (gen !== generation) return;
    const to = deliver;
    deliver = null;
    set({ phase: 'idle', target: null });
    if (text && to) to(text);
  } catch (err) {
    if (gen !== generation) return;
    deliver = null;
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Drops the recording, or the transcription under way; nothing is
 *  written. */
export function cancelDictation(): void {
  if (state.phase === 'recording' || state.phase === 'loading' || state.phase === 'transcribing') {
    generation += 1;
    recording?.cancel();
    recording = null;
    deliver = null;
    // A transcription cannot be called back: the engine goes with it.
    if (state.phase === 'transcribing') stopEngine(new Error('cancelled'));
    set({ phase: 'idle', target: null, startedAt: null });
  } else if (state.phase === 'consent') {
    declineModelDownload();
  }
}

/** Ends the engine; every transcription waiting on it fails with `err`. */
function stopEngine(err: Error): void {
  worker?.terminate();
  worker = null;
  workerReady = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

export function clearDictationError(): void {
  if (state.error) set({ error: null });
}

function ensureWorker(): Promise<void> {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    const started = performance.now();
    const res = await api().assets();
    if (!res.ok) {
      set({ model: res.state });
      throw new Error(res.state.state === 'failed' ? res.state.message : 'the speech model is not on this computer');
    }
    const w = new WhisperWorker();
    let ready = false;
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
      // Before it is ready a crash fails the start; after, it fails what is
      // waiting and the next dictation starts a new engine.
      w.onerror = (e) => {
        const err = new Error(e.message || 'the speech engine stopped');
        if (!ready) return reject(err);
        if (worker === w) stopEngine(err);
      };
      const { assets } = res;
      const init: WorkerRequest = { type: 'init', assets };
      w.postMessage(init, [assets.encoder.buffer, assets.decoder.buffer, assets.wasm.buffer] as Transferable[]);
    });
    ready = true;
    worker = w;
    console.log(`[wmux:dictation] speech engine ready in ${Math.round(performance.now() - started)} ms`);
    restIdleEngine();
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
  idleTimer = null;
  const id = nextId++;
  const windows = Math.max(1, Math.ceil(audio.length / WINDOW_SAMPLES));
  const deadlineMs = TRANSCRIBE_DEADLINE.BASE_MS + TRANSCRIBE_DEADLINE.PER_WINDOW_MS * windows;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const text = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    deadline = setTimeout(() => {
      if (worker === w) stopEngine(new Error('the speech engine took too long'));
    }, deadlineMs);
    const req: WorkerRequest = { type: 'transcribe', id, audio, language: dictationLanguageFor(getLocale()) };
    w.postMessage(req, [audio.buffer]);
  }).finally(() => {
    if (deadline) clearTimeout(deadline);
  });
  restIdleEngine();
  return text.trim();
}

/** The engine holds the model in memory: let it go when dictation rests. */
function restIdleEngine(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.phase === 'loading' || state.phase === 'recording' || state.phase === 'transcribing') return restIdleEngine();
    worker?.terminate();
    worker = null;
    workerReady = null;
    idleTimer = null;
  }, IDLE_ENGINE_MS);
}
