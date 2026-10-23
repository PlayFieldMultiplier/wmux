// Voice dictation: the speech model wmux downloads once, with the owner's
// consent, and the shapes main and the renderer pass for it. The model runs
// on this computer (renderer/dictation/whisper.ts); audio never leaves the
// renderer's memory.

/** OpenAI's Whisper base (MIT), as onnx-community converts it to ONNX,
 *  pinned to one revision; each file is checked against its size and
 *  SHA-256 before it is used. */
export const DICTATION_MODEL = {
  name: 'Whisper base',
  repo: 'onnx-community/whisper-base',
  revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
  host: 'huggingface.co',
  /** Where huggingface.co redirects the large files (regional hosts under
   *  it, e.g. us.aws.cdn.hf.co). */
  cdn: 'cdn.hf.co',
  licence: 'MIT',
  /** What the engine reads; nothing else of the repository is fetched. */
  files: [
    { path: 'generation_config.json', size: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
    { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { path: 'onnx/encoder_model_quantized.onnx', size: 23201314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46' },
    { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53693315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' },
  ],
} as const;

export type DictationModelFile = (typeof DICTATION_MODEL.files)[number];

/** The download's size in bytes (the consent names it). */
export const DICTATION_MODEL_BYTES = DICTATION_MODEL.files.reduce((sum, f) => sum + f.size, 0);

/** Where a model file is downloaded from. */
export function dictationModelUrl(file: { path: string }): string {
  return `https://${DICTATION_MODEL.host}/${DICTATION_MODEL.repo}/resolve/${DICTATION_MODEL.revision}/${file.path}`;
}

/** Whether a download may come from `hostname`: Hugging Face itself or its
 *  CDN. Pure. */
export function isDictationModelHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === DICTATION_MODEL.host || h === DICTATION_MODEL.cdn || h.endsWith(`.${DICTATION_MODEL.cdn}`);
}

export type DictationModelState =
  | { state: 'absent' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'ready' }
  | { state: 'failed'; message: string };

/** What the renderer's speech engine is built from, read from the model
 *  folder and the app's own files after the model checks out. */
export interface DictationAssets {
  encoder: Uint8Array;
  decoder: Uint8Array;
  /** tokenizer.json's text. */
  tokenizer: string;
  /** generation_config.json's suppress_tokens / begin_suppress_tokens. */
  suppress: number[];
  beginSuppress: number[];
  /** onnxruntime-web's WebAssembly binary, shipped with the app. */
  wasm: Uint8Array;
}

export type DictationAssetsResult = { ok: true; assets: DictationAssets } | { ok: false; state: DictationModelState };

/** The microphone's standing with the OS (macOS asks once, on first use;
 *  elsewhere the answer is always `granted`). */
export type DictationMicAccess = 'granted' | 'denied';
