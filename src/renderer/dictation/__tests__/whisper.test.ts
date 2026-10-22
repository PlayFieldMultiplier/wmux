// The hand-written Whisper parts against Whisper's own: log-mel features and
// the byte-level BPE decode. The reference values come from openai-whisper
// (MIT), generated once offline by scripts/dictation/gen-whisper-reference.py
// into fixtures/whisper-reference.json; no Whisper code is copied here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECODE_LIMITS, SAMPLE_RATE, WhisperTokenizer, endsInLoop, logMelSpectrogram } from '../whisper';

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
  it('sees an n-gram repeated REPEATS times in a row, and nothing short of it', () => {
    const loop = Array.from({ length: DECODE_LIMITS.REPEATS }, () => [7, 8, 9]).flat();
    expect(endsInLoop([1, 2, ...loop])).toBe(true);
    expect(endsInLoop([1, 2, ...loop.slice(1)])).toBe(false);
    expect(endsInLoop([5, 5, 5])).toBe(DECODE_LIMITS.REPEATS <= 3);
    expect(endsInLoop([1, 2, 3, 4, 5, 6])).toBe(false);
  });
});
