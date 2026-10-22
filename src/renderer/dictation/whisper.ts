// Whisper speech-to-text on onnxruntime-web, without a model framework: the
// log-mel features, a greedy decode over the merged decoder with its KV
// cache, and the byte-level BPE decode. The approach mirrors OpenAI Whisper
// (https://github.com/openai/whisper, MIT, Copyright (c) 2022 OpenAI), and
// was reimplemented here against the model card's numbers
// (onnx-community/whisper-base: 80 mel bins, n_fft 400, hop 160, 30 s
// windows; 6 decoder layers, 8 heads of 64); no code was copied. See
// THIRD_PARTY_NOTICES. Pure apart from the `ort` sessions it is handed, so
// it runs in a worker and under Node alike.

import type * as Ort from 'onnxruntime-web';

type InferenceSession = Ort.InferenceSession;
type Tensor = Ort.Tensor;

export const SAMPLE_RATE = 16_000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const N_FREQS = N_FFT / 2 + 1;
/** One 30 s window, as the encoder takes it. */
export const WINDOW_SAMPLES = 30 * SAMPLE_RATE;
const N_FRAMES = WINDOW_SAMPLES / HOP;

export const WHISPER_TOKENS = {
  EOT: 50257,
  SOT: 50258,
  TRANSCRIBE: 50359,
  NO_TIMESTAMPS: 50363,
  /** Whisper's language tokens run from English to Sundanese. */
  LANG_FIRST: 50259,
  LANG_LAST: 50357,
  /** The language tokens of the languages wmux's UI is written in, by the
   *  UI language's code (Norwegian Bokmål is Whisper's `no`). */
  LANG: {
    en: 50259, zh: 50260, 'zh-TW': 50260, de: 50261, es: 50262, ru: 50263, ko: 50264, fr: 50265, ja: 50266,
    'pt-BR': 50267, tr: 50268, pl: 50269, it: 50274, id: 50275, hi: 50276, vi: 50278, uk: 50280, ms: 50282,
    da: 50285, nb: 50288, th: 50289, ar: 50272, bs: 50315,
  } as const,
} as const;

export type DictationLanguage = keyof typeof WHISPER_TOKENS.LANG;

/** The language to write in for a UI language: its own when Whisper has
 *  it, else `auto` (the model picks). Pure. */
export function dictationLanguageFor(locale: string): DictationLanguage | 'auto' {
  return Object.prototype.hasOwnProperty.call(WHISPER_TOKENS.LANG, locale) ? locale as DictationLanguage : 'auto';
}

export const DECODE_LIMITS = {
  /** Tokens one window may produce: a 30 s window of fast speech is ~150. */
  MAX_TOKENS: 224,
  /** A run of the same n-gram this many times in a row is a loop. */
  REPEATS: 3,
  NGRAM_MAX: 8,
  /** Below this RMS a window is silence: Whisper invents words for it. */
  SILENCE_RMS: 0.002,
} as const;

// ─── Features ───────────────────────────────────────────────────────────────

function hzToMel(hz: number): number {
  // Slaney's scale: linear to 1 kHz, logarithmic above.
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
}

function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logStep * (mel - minLogMel));
}

let melBank: Float32Array | null = null;

/** The 80 × 201 Slaney-normalised triangular filters Whisper was trained
 *  with (librosa's mel filters for 16 kHz, n_fft 400). */
export function melFilters(): Float32Array {
  if (melBank) return melBank;
  const bank = new Float32Array(N_MELS * N_FREQS);
  const maxMel = hzToMel(SAMPLE_RATE / 2);
  const points = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz((maxMel * i) / (N_MELS + 1)));
  for (let m = 0; m < N_MELS; m += 1) {
    const [lo, mid, hi] = [points[m], points[m + 1], points[m + 2]];
    const norm = 2 / (hi - lo);
    for (let k = 0; k < N_FREQS; k += 1) {
      const f = (k * SAMPLE_RATE) / N_FFT;
      const w = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid)));
      bank[m * N_FREQS + k] = w * norm;
    }
  }
  melBank = bank;
  return bank;
}

let dft: { cos: Float32Array; sin: Float32Array; hann: Float32Array } | null = null;

function dftTables() {
  if (dft) return dft;
  const cos = new Float32Array(N_FFT);
  const sin = new Float32Array(N_FFT);
  const hann = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n += 1) {
    cos[n] = Math.cos((2 * Math.PI * n) / N_FFT);
    sin[n] = Math.sin((2 * Math.PI * n) / N_FFT);
    // Periodic Hann, as torch.hann_window(400) gives.
    hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  }
  dft = { cos, sin, hann };
  return dft;
}

/** The encoder's input for one window: 80 × 3000 log-mel values, the audio
 *  zero-padded (or cut) to 30 s, centred frames with reflect padding, the
 *  log floored 8 below its peak and scaled as Whisper scales it. */
export function logMelSpectrogram(audio: Float32Array): Float32Array {
  const samples = new Float32Array(WINDOW_SAMPLES);
  samples.set(audio.subarray(0, WINDOW_SAMPLES));
  const pad = N_FFT / 2;
  const at = (i: number): number => {
    // Reflect padding at both ends (no edge repeat).
    const j = i < 0 ? -i : i >= WINDOW_SAMPLES ? 2 * (WINDOW_SAMPLES - 1) - i : i;
    return samples[j];
  };
  const { cos, sin, hann } = dftTables();
  const bank = melFilters();
  const out = new Float32Array(N_MELS * N_FRAMES);
  // Frames past the audio (and its reflection) are silence: skip their DFT.
  const audible = Math.min(N_FRAMES, Math.ceil((Math.min(audio.length, WINDOW_SAMPLES) + pad) / HOP) + 1);
  const frame = new Float32Array(N_FFT);
  const power = new Float32Array(N_FREQS);
  let peak = -Infinity;
  for (let t = 0; t < N_FRAMES; t += 1) {
    if (t < audible) {
      const start = t * HOP - pad;
      for (let n = 0; n < N_FFT; n += 1) frame[n] = at(start + n) * hann[n];
      for (let k = 0; k < N_FREQS; k += 1) {
        let re = 0;
        let im = 0;
        let idx = 0;
        for (let n = 0; n < N_FFT; n += 1) {
          re += frame[n] * cos[idx];
          im -= frame[n] * sin[idx];
          idx += k;
          if (idx >= N_FFT) idx -= N_FFT;
        }
        power[k] = re * re + im * im;
      }
    } else {
      power.fill(0);
    }
    for (let m = 0; m < N_MELS; m += 1) {
      let sum = 0;
      const row = m * N_FREQS;
      for (let k = 0; k < N_FREQS; k += 1) sum += bank[row + k] * power[k];
      const v = Math.log10(Math.max(sum, 1e-10));
      out[m * N_FRAMES + t] = v;
      if (v > peak) peak = v;
    }
  }
  const floor = peak - 8;
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** GPT-2's byte ↔ printable-character table, inverted: the character a
 *  byte-level BPE token spells each byte with → that byte. */
function unicodeToByte(): Map<string, number> {
  const bytes: number[] = [];
  for (let b = 33; b <= 126; b += 1) bytes.push(b);
  for (let b = 161; b <= 172; b += 1) bytes.push(b);
  for (let b = 174; b <= 255; b += 1) bytes.push(b);
  const chars = [...bytes];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      chars.push(256 + n);
      n += 1;
    }
  }
  return new Map(bytes.map((b, i) => [String.fromCodePoint(chars[i]), b]));
}

export class WhisperTokenizer {
  private readonly byId: string[];
  private readonly byteOf = unicodeToByte();

  /** From tokenizer.json's text: its BPE vocabulary (special tokens are
   *  never spelled out, so the added ones are not needed). */
  constructor(tokenizerJson: string) {
    const parsed = JSON.parse(tokenizerJson) as { model?: { vocab?: Record<string, number> } };
    const vocab = parsed.model?.vocab;
    if (!vocab || typeof vocab !== 'object') throw new Error('tokenizer.json has no BPE vocabulary');
    this.byId = [];
    for (const [token, id] of Object.entries(vocab)) {
      if (Number.isInteger(id) && id >= 0 && id < WHISPER_TOKENS.EOT) this.byId[id] = token;
    }
  }

  /** The text of `ids`, special tokens left out; a split multi-byte
   *  character at the end is dropped rather than shown as U+FFFD. */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      const token = this.byId[id];
      if (token === undefined) continue;
      for (const ch of token) {
        const b = this.byteOf.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes)).replace(/\uFFFD+$/u, '');
  }
}

// ─── Decoding ───────────────────────────────────────────────────────────────

/** The parts of onnxruntime this needs, so a test or Node passes its own. */
export type WhisperOrt = Pick<typeof Ort, 'Tensor'>;

export interface WhisperSessions {
  encoder: InferenceSession;
  decoder: InferenceSession;
}

export interface TranscribeOptions {
  /** The language to write in; `auto` lets the model pick. */
  language: DictationLanguage | 'auto';
  /** Tokens the model may never produce (generation_config.json). */
  suppress: readonly number[];
  /** Tokens it may not start with (generation_config.json). */
  beginSuppress: readonly number[];
}

/** Whether the newest tokens repeat one n-gram DECODE_LIMITS.REPEATS times
 *  in a row: Whisper's failure mode on noise. Pure. */
export function endsInLoop(ids: readonly number[]): boolean {
  for (let n = 1; n <= DECODE_LIMITS.NGRAM_MAX; n += 1) {
    const span = n * DECODE_LIMITS.REPEATS;
    if (ids.length < span) break;
    let loop = true;
    for (let i = ids.length - span; i < ids.length - n && loop; i += 1) loop = ids[i] === ids[i + n];
    if (loop) return true;
  }
  return false;
}

/** The ids of one window's text, without the loop a repeat ended on. Stops
 *  at end-of-text, DECODE_LIMITS.MAX_TOKENS, or a repeat loop. */
async function decodeWindow(ort: WhisperOrt, sessions: WhisperSessions, encoded: Tensor, opts: TranscribeOptions): Promise<number[]> {
  const layers = sessions.decoder.inputNames.filter((n) => /^past_key_values\.\d+\.decoder\.key$/.test(n)).length;
  const heads = 8;
  const headDim = 64;
  const empty = () => new ort.Tensor('float32', new Float32Array(0), [1, heads, 0, headDim]);
  const past: Record<string, Tensor> = {};
  for (let l = 0; l < layers; l += 1) {
    for (const side of ['decoder', 'encoder']) for (const kv of ['key', 'value']) past[`past_key_values.${l}.${side}.${kv}`] = empty();
  }
  let first = true;
  const step = async (ids: readonly number[]): Promise<Float32Array> => {
    const feeds: Record<string, Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      encoder_hidden_states: encoded,
      use_cache_branch: new ort.Tensor('bool', [!first], [1]),
      ...past,
    };
    const out = await sessions.decoder.run(feeds);
    for (let l = 0; l < layers; l += 1) {
      for (const kv of ['key', 'value']) {
        past[`past_key_values.${l}.decoder.${kv}`] = out[`present.${l}.decoder.${kv}`];
        // The encoder's keys and values come out of the first step only.
        if (first) past[`past_key_values.${l}.encoder.${kv}`] = out[`present.${l}.encoder.${kv}`];
      }
    }
    first = false;
    const logits = out.logits;
    const vocab = logits.dims[2];
    const data = logits.data as Float32Array;
    return data.subarray(data.length - vocab);
  };

  let logits = await step([WHISPER_TOKENS.SOT]);
  const lang = opts.language === 'auto' ? detectLanguage(logits) : WHISPER_TOKENS.LANG[opts.language];
  logits = await step([lang, WHISPER_TOKENS.TRANSCRIBE, WHISPER_TOKENS.NO_TIMESTAMPS]);
  const suppress = new Set(opts.suppress);
  const out: number[] = [];
  while (out.length < DECODE_LIMITS.MAX_TOKENS) {
    let best = -1;
    let bestScore = -Infinity;
    for (let id = 0; id < logits.length; id += 1) {
      // Text only: every special token but end-of-text stays out.
      if (id > WHISPER_TOKENS.EOT || suppress.has(id)) continue;
      if (out.length === 0 && opts.beginSuppress.includes(id)) continue;
      if (logits[id] > bestScore) {
        bestScore = logits[id];
        best = id;
      }
    }
    if (best < 0 || best === WHISPER_TOKENS.EOT) break;
    out.push(best);
    if (endsInLoop(out)) {
      trimLoop(out);
      break;
    }
    logits = await step([best]);
  }
  return out;
}

/** The language token the first step's logits rank highest. Pure. */
export function detectLanguage(logits: ArrayLike<number>): number {
  let best: number = WHISPER_TOKENS.LANG_FIRST;
  for (let id = WHISPER_TOKENS.LANG_FIRST; id <= WHISPER_TOKENS.LANG_LAST; id += 1) if (logits[id] > logits[best]) best = id;
  return best;
}

/** Drops the repeats of the loop `ids` ends on, keeping its first copy. */
function trimLoop(ids: number[]): void {
  for (let n = 1; n <= DECODE_LIMITS.NGRAM_MAX; n += 1) {
    const span = n * DECODE_LIMITS.REPEATS;
    if (ids.length < span) break;
    let loop = true;
    for (let i = ids.length - span; i < ids.length - n && loop; i += 1) loop = ids[i] === ids[i + n];
    if (loop) {
      ids.length -= span - n;
      return;
    }
  }
}

function rms(audio: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < audio.length; i += 1) sum += audio[i] * audio[i];
  return audio.length > 0 ? Math.sqrt(sum / audio.length) : 0;
}

/** The text of 16 kHz mono audio, one 30 s window after another. A silent
 *  window gives nothing rather than Whisper's invented words. */
export async function transcribe(ort: WhisperOrt, sessions: WhisperSessions, tokenizer: WhisperTokenizer, audio: Float32Array, opts: TranscribeOptions): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < audio.length; start += WINDOW_SAMPLES) {
    const window = audio.subarray(start, start + WINDOW_SAMPLES);
    if (rms(window) < DECODE_LIMITS.SILENCE_RMS) continue;
    const features = new ort.Tensor('float32', logMelSpectrogram(window), [1, N_MELS, N_FRAMES]);
    const { last_hidden_state: encoded } = await sessions.encoder.run({ input_features: features });
    const text = tokenizer.decode(await decodeWindow(ort, sessions, encoded, opts)).trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}
