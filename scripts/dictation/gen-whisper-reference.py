# Reference values for wmux's dictation tests, from openai-whisper's own
# feature and tokenizer code (MIT). Run once offline:
#   uv run --no-project --with openai-whisper==20250625 python gen.py <tokenizer.json> <out.json>
import json, math, sys
import numpy as np
import torch
import whisper
from whisper.tokenizer import get_tokenizer

SR = 16000
n = int(0.75 * SR)
t = np.arange(n) / SR
# Deterministic test signal: two tones, a chirp and a decaying envelope.
sig = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 1870 * t) \
    + 0.1 * np.sin(2 * np.pi * (200 + 3000 * t) * t)
sig *= np.exp(-1.5 * t)
sig = sig.astype(np.float32)
mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(torch.from_numpy(sig)), n_mels=80).numpy()
frames = 90
tok = get_tokenizer(multilingual=True, num_languages=99)
texts = ["안녕하세요. 오늘 회의는 세 시에 시작합니다.", "Please open the pull request, then run the tests!", "커밋 메시지는 English로, 주석은 한국어로 써 주세요 🙂"]
cases = []
used = set()
for text in texts:
    ids = tok.encode(" " + text)
    cases.append({"ids": ids, "text": tok.decode(ids)})
    used.update(ids)
full = json.load(open(sys.argv[1]))["model"]["vocab"]
vocab = {k: v for k, v in full.items() if v in used}
json.dump({
    "source": "openai-whisper 20250625 (MIT): whisper.log_mel_spectrogram and get_tokenizer(multilingual=True)",
    "signal": "0.75 s at 16 kHz: 0.3 sin(440 Hz) + 0.2 sin(1870 Hz) + 0.1 chirp(200 Hz + 3000 Hz/s), times exp(-1.5 t), float32",
    "frames": frames,
    "mel": [[round(float(v), 6) for v in mel[m, :frames]] for m in range(80)],
    "melTail": round(float(mel[0, -1]), 6),
    "bpe": {"vocab": vocab, "cases": cases},
}, open(sys.argv[2], "w"), ensure_ascii=False)
print("ok", mel.shape, len(vocab))
