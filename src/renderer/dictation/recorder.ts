// One dictation's audio: the microphone through MediaRecorder, kept as Blob
// chunks in memory only, then decoded to 16 kHz mono for Whisper. Nothing is
// written anywhere; the chunks go with the recording.

import { SAMPLE_RATE } from './whisper';

/** A dictation longer than this stops by itself (four Whisper windows). */
export const MAX_RECORDING_MS = 120_000;

export interface Recording {
  /** Stops and returns the audio, 16 kHz mono. */
  stop: () => Promise<Float32Array>;
  /** Stops and drops the audio. */
  cancel: () => void;
}

export async function startRecording(onAutoStop: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const release = () => {
    clearTimeout(cap);
    for (const track of stream.getTracks()) track.stop();
  };
  const cap = setTimeout(onAutoStop, MAX_RECORDING_MS);
  recorder.start();
  return {
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      release();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      chunks.length = 0;
      return decodeTo16k(await blob.arrayBuffer());
    },
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
      chunks.length = 0;
    },
  };
}

/** Compressed audio → 16 kHz mono samples (decodeAudioData resamples to
 *  the context's rate). */
export async function decodeTo16k(data: ArrayBuffer): Promise<Float32Array> {
  if (data.byteLength === 0) return new Float32Array(0);
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(data);
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i += 1) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  return mono;
}
