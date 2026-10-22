// @vitest-environment jsdom
//
// The dictation controller's edges: a start that a cancel overtakes leaves no
// microphone open, a second press while one starts opens nothing, a crashed
// or hung engine fails what waits on it and is replaced, and a browser's
// refusal of the microphone reads as `mic-denied`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const h = vi.hoisted(() => ({
  workers: [] as Array<{ onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: { message: string }) => void) | null; posted: Array<{ type: string; id?: number }>; terminated: boolean }>,
  startRecording: vi.fn(),
}));

vi.mock('../whisper.worker?worker', () => ({
  default: class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    posted: Array<{ type: string; id?: number }> = [];
    terminated = false;
    constructor() {
      h.workers.push(this);
    }
    postMessage(msg: { type: string; id?: number }) {
      this.posted.push(msg);
      if (msg.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }
    terminate() {
      this.terminated = true;
    }
  },
}));
vi.mock('../recorder', () => ({ startRecording: h.startRecording }));

type Controller = typeof import('../dictation');
let d: Controller;
let mic: Deferred<'granted' | 'denied'> | null;

const assets = () => ({ ok: true, assets: { encoder: new Uint8Array(1), decoder: new Uint8Array(1), tokenizer: '{}', suppress: [], beginSuppress: [], wasm: new Uint8Array(1) } });
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetModules();
  h.workers.length = 0;
  h.startRecording.mockReset();
  mic = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    dictation: {
      status: vi.fn(async () => ({ state: 'ready' })),
      micAccess: vi.fn(() => (mic ? mic.promise : Promise.resolve('granted'))),
      assets: vi.fn(async () => assets()),
      onState: vi.fn(() => () => undefined),
      download: vi.fn(),
      cancel: vi.fn(),
    },
  };
  d = await import('../dictation');
});

afterEach(() => {
  vi.useRealTimers();
});

function recording(audio = new Float32Array(16_000)) {
  return { stop: vi.fn(async () => audio), cancel: vi.fn() };
}

describe('starting', () => {
  it('Esc while the microphone opens closes the recording that arrives after it', async () => {
    const opening = deferred<ReturnType<typeof recording>>();
    h.startRecording.mockReturnValue(opening.promise);
    const done = d.toggleDictation('chat:a', vi.fn());
    await flush();
    expect(d.getDictationState().phase).toBe('loading');
    d.cancelDictation();
    const rec = recording();
    opening.resolve(rec);
    await done;
    expect(rec.cancel).toHaveBeenCalled();
    expect(d.getDictationState()).toMatchObject({ phase: 'idle', target: null, error: null });
  });

  it('a cancel while the OS answers for the microphone opens nothing', async () => {
    mic = deferred();
    const done = d.toggleDictation('chat:a', vi.fn());
    await flush();
    d.cancelDictation();
    mic.resolve('granted');
    await done;
    expect(h.startRecording).not.toHaveBeenCalled();
    expect(d.getDictationState().phase).toBe('idle');
  });

  it('a second press while one starts opens no second recording', async () => {
    h.startRecording.mockResolvedValue(recording());
    const first = d.toggleDictation('chat:a', vi.fn());
    const second = d.toggleDictation('chat:a', vi.fn());
    await Promise.all([first, second]);
    expect(h.startRecording).toHaveBeenCalledTimes(1);
    expect(d.getDictationState().phase).toBe('recording');
  });

  it('a browser refusal of the microphone reads as mic-denied', async () => {
    h.startRecording.mockRejectedValue(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await d.toggleDictation('chat:a', vi.fn());
    expect(d.getDictationState()).toMatchObject({ phase: 'idle', error: 'mic-denied' });
    expect(d.micError(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe('mic-denied');
    expect(d.micError(new Error('other'))).toBeNull();
  });
});

describe('the engine', () => {
  async function recordThenStop(onText = vi.fn()) {
    h.startRecording.mockResolvedValue(recording());
    await d.toggleDictation('chat:a', onText);
    const stopped = d.stopDictation();
    await flush();
    return { stopped, onText, worker: h.workers.at(-1)! };
  }

  it('a crash after it is ready fails the transcription waiting on it, and the next dictation starts a new engine', async () => {
    const { stopped, onText, worker } = await recordThenStop();
    expect(worker.posted.map((m) => m.type)).toEqual(['init', 'transcribe']);
    worker.onerror?.({ message: 'RuntimeError: unreachable' });
    await stopped;
    expect(onText).not.toHaveBeenCalled();
    expect(d.getDictationState()).toMatchObject({ phase: 'idle', error: 'RuntimeError: unreachable' });
    expect(worker.terminated).toBe(true);
    h.startRecording.mockResolvedValue(recording());
    await d.toggleDictation('chat:a', vi.fn());
    expect(h.workers).toHaveLength(2);
  });

  it('a transcription past its deadline lets the engine go and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stopped, worker } = await recordThenStop();
    await vi.advanceTimersByTimeAsync(d.TRANSCRIBE_DEADLINE.BASE_MS + d.TRANSCRIBE_DEADLINE.PER_WINDOW_MS - 1);
    expect(d.getDictationState().phase).toBe('transcribing');
    await vi.advanceTimersByTimeAsync(2);
    await stopped;
    expect(worker.terminated).toBe(true);
    expect(d.getDictationState()).toMatchObject({ phase: 'idle', error: 'the speech engine took too long' });
  });

  it('Esc while transcribing stops the engine, writes nothing and reports nothing', async () => {
    const { stopped, onText, worker } = await recordThenStop();
    d.cancelDictation();
    await stopped;
    expect(worker.terminated).toBe(true);
    expect(onText).not.toHaveBeenCalled();
    expect(d.getDictationState()).toMatchObject({ phase: 'idle', error: null });
  });
});
