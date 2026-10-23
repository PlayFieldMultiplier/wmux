import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findQwenTranscriptCandidates, qwenProjectsRoot } from '../qwenTranscript';

const ID = '0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-qwen-root-')); });
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('qwenProjectsRoot', () => {
  it('reads one env: the launch env when given, else the daemon\'s, runtime dir before QWEN_HOME before ~/.qwen', () => {
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(home, 'daemon-runtime'));
    // The pane's QWEN_HOME wins over the daemon's runtime dir: the envs are not mixed.
    expect(qwenProjectsRoot({ QWEN_HOME: path.join(home, 'pane') })).toBe(path.join(home, 'pane', 'projects'));
    expect(qwenProjectsRoot({ QWEN_RUNTIME_DIR: path.join(home, 'rt'), QWEN_HOME: path.join(home, 'pane') })).toBe(path.join(home, 'rt', 'projects'));
    expect(qwenProjectsRoot({ HOME: home })).toBe(path.join(home, '.qwen', 'projects'));
    expect(qwenProjectsRoot()).toBe(path.join(home, 'daemon-runtime', 'projects'));
  });
});

describe('findQwenTranscriptCandidates', () => {
  it('a scan that stops at its candidate cap is not complete', () => {
    for (let i = 0; i < 9; i++) {
      const dir = path.join(home, 'projects', `p${i}`, 'chats');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ID}.jsonl`), '{}\n');
    }
    const report = { complete: true };
    expect(findQwenTranscriptCandidates(ID, { QWEN_HOME: home }, report)).toHaveLength(8);
    expect(report.complete).toBe(false);
  });
});
