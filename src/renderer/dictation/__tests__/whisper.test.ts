// The hand-written Whisper parts against Whisper's own: log-mel features and
// the byte-level BPE decode. The reference values come from openai-whisper
// (MIT), generated once offline by scripts/dictation/gen-whisper-reference.py
// into fixtures/whisper-reference.json; no Whisper code is copied here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DECODE_LIMITS, PREFERRED_LANGUAGE_MIN_SHARE, SAMPLE_RATE, WHISPER_TOKENS, WhisperTokenizer, chooseLanguage, dictationLanguageFor, endsInLoop, logMelSpectrogram, noSpeechProbability, transcribe, type WhisperOrt, type WhisperSessions } from '../whisper';

const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'whisper-reference.json'), 'utf8')) as {
  frames: number;
  mel: number[][];
  melTail: number;
  bpe: { vocab: Record<string, number>; cases: Array<{ ids: number[]; text: string }> };
};

/** The fixture's signal, as the generator builds it. */
function signal(): Float32Array {
  const n = Math.round(0.75 * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const v = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 1870 * t) + 0.1 * Math.sin(2 * Math.PI * (200 + 3000 * t) * t);
    out[i] = v * Math.exp(-1.5 * t);
  }
  return out;
}

describe('logMelSpectrogram', () => {
  // Float32 sums over 400 samples against Whisper's float32 torch STFT; the
  // features land in about [-1.5, 1.5], and the worst error measured is 3e-5.
  const TOLERANCE = 1e-4;

  it('matches Whisper\'s log-mel within the tolerance, for the audio and the silent padding after it', () => {
    const mel = logMelSpectrogram(signal());
    let worst = 0;
    for (let m = 0; m < 80; m += 1) {
      for (let t = 0; t < reference.frames; t += 1) worst = Math.max(worst, Math.abs(mel[m * 3000 + t] - reference.mel[m][t]));
    }
    expect(worst).toBeLessThan(TOLERANCE);
    expect(Math.abs(mel[2999] - reference.melTail)).toBeLessThan(TOLERANCE);
  });
});

describe('WhisperTokenizer', () => {
  const tokenizer = new WhisperTokenizer(JSON.stringify({ model: { vocab: reference.bpe.vocab } }));

  it('decodes token ids to Whisper\'s text, Korean and an emoji spread over byte tokens included', () => {
    for (const c of reference.bpe.cases) expect(tokenizer.decode(c.ids)).toBe(c.text);
  });

  it('leaves out special tokens and a character cut off at the end', () => {
    const korean = reference.bpe.cases[0];
    expect(tokenizer.decode([50258, 50264, ...korean.ids, 50257])).toBe(korean.text);
    const emoji = reference.bpe.cases[2];
    expect(tokenizer.decode(emoji.ids.slice(0, -1))).toBe(emoji.text.slice(0, -2));
  });
});

describe('endsInLoop', () => {
  it('a stuck n-gram is a loop; a word said a few times, or a long number, is speech', () => {
    const loop = Array.from({ length: DECODE_LIMITS.REPEATS_MIN }, () => [7, 8, 9]).flat();
    expect(endsInLoop([1, 2, ...loop])).toBe(true);
    expect(endsInLoop([1, 2, ...loop.slice(1)])).toBe(false);
    // "네 네 네": one token three times, and "1,000,000,000": ",000" three times.
    expect(endsInLoop([5, 5, 5])).toBe(false);
    expect(endsInLoop([16, 11, 1360, 11, 1360, 11, 1360])).toBe(false);
    // One token needs LOOP_TOKENS_MIN copies.
    expect(endsInLoop(Array(DECODE_LIMITS.LOOP_TOKENS_MIN - 1).fill(5))).toBe(false);
    expect(endsInLoop(Array(DECODE_LIMITS.LOOP_TOKENS_MIN).fill(5))).toBe(true);
    expect(endsInLoop([1, 2, 3, 4, 5, 6])).toBe(false);
  });
});

describe('noSpeechProbability', () => {
  it('reads the <|nospeech|> share of the first step\'s logits', () => {
    const logits = new Float32Array(51865).fill(-20);
    logits[WHISPER_TOKENS.NO_SPEECH] = 10;
    expect(noSpeechProbability(logits)).toBeGreaterThan(DECODE_LIMITS.NO_SPEECH_MAX);
    logits[WHISPER_TOKENS.LANG.ko] = 12;
    expect(noSpeechProbability(logits)).toBeLessThan(DECODE_LIMITS.NO_SPEECH_MAX);
  });
});

describe('chooseLanguage', () => {
  /** First-step logits where only the language tokens named have a say. */
  const logits = (scores: Record<number, number>) => {
    const out = new Float32Array(51865).fill(-50);
    for (const [id, v] of Object.entries(scores)) out[Number(id)] = v;
    return out;
  };
  const { ko, en } = WHISPER_TOKENS.LANG;

  it('keeps the UI language while the model finds it plausible, and follows the speech otherwise', () => {
    // Korean speech with an English UI: forcing English would translate it.
    expect(chooseLanguage(logits({ [ko]: 5, [en]: 1 }), 'en')).toBe(ko);
    // A close call goes to the UI language.
    expect(chooseLanguage(logits({ [ko]: 1, [en]: 0.5 }), 'en')).toBe(en);
    expect(chooseLanguage(logits({ [ko]: 1, [en]: 0.5 }), 'auto')).toBe(ko);
    expect(PREFERRED_LANGUAGE_MIN_SHARE).toBeGreaterThan(0);
  });

  it('maps the UI language to Whisper\'s, and a language Whisper lacks to auto', () => {
    expect(dictationLanguageFor('ko')).toBe('ko');
    expect(dictationLanguageFor('zh-TW')).toBe('zh-TW');
    expect(dictationLanguageFor('xx')).toBe('auto');
  });
});

describe('transcribe', () => {
  // Stand-ins for onnxruntime: the decoder answers each step with logits
  // from `steps`, one array per call.
  class FakeTensor {
    constructor(readonly type: string, readonly data: unknown, readonly dims: readonly number[] = []) {}
  }
  const ort = { Tensor: FakeTensor } as unknown as WhisperOrt;
  function sessions(steps: Array<Record<number, number>>) {
    let call = 0;
    const decoder = {
      inputNames: ['input_ids', 'encoder_hidden_states', 'past_key_values.0.decoder.key', 'past_key_values.0.decoder.value', 'past_key_values.0.encoder.key', 'past_key_values.0.encoder.value', 'use_cache_branch'],
      run: vi.fn(async () => {
        const logits = new Float32Array(51865).fill(-30);
        for (const [id, v] of Object.entries(steps[Math.min(call, steps.length - 1)])) logits[Number(id)] = v;
        call += 1;
        const kv = new FakeTensor('float32', new Float32Array(0), [1, 8, 0, 64]);
        return { logits: new FakeTensor('float32', logits, [1, 1, 51865]), 'present.0.decoder.key': kv, 'present.0.decoder.value': kv, 'present.0.encoder.key': kv, 'present.0.encoder.value': kv };
      }),
    };
    const encoder = { run: vi.fn(async () => ({ last_hidden_state: new FakeTensor('float32', new Float32Array(0)) })) };
    return { encoder, decoder } as unknown as WhisperSessions & { decoder: { run: ReturnType<typeof vi.fn> } };
  }
  const tokenizer = new WhisperTokenizer(JSON.stringify({ model: { vocab: reference.bpe.vocab } }));
  const korean = reference.bpe.cases[0];
  const loud = () => Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.2 * Math.sin(i / 5));
  const opts = { language: 'auto' as const, suppress: [], beginSuppress: [] };

  it('a window the model hears as no speech types nothing', async () => {
    const s = sessions([{ [WHISPER_TOKENS.NO_SPEECH]: 10, [WHISPER_TOKENS.LANG.en]: 2 }]);
    expect(await transcribe(ort, s, tokenizer, loud(), opts)).toBe('');
    expect(s.decoder.run).toHaveBeenCalledTimes(1);
  });

  it('speech is decoded token by token to the end of text', async () => {
    const steps = [{ [WHISPER_TOKENS.LANG.ko]: 10 }, ...korean.ids.map((id) => ({ [id]: 10 })), { [WHISPER_TOKENS.EOT]: 10 }];
    expect(await transcribe(ort, sessions(steps), tokenizer, loud(), opts)).toBe(korean.text.trim());
  });
});
