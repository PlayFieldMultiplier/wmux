import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearWebState, getWebStatePath } from '../webStateStore';
import { getWebPrefsPath, loadWebPrefs, saveWebPrefs } from '../webPrefsStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-webprefs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('webPrefsStore (#1641 inline images switch)', () => {
  it('defaults to images on with no file, or a malformed one', () => {
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: true });
    fs.writeFileSync(getWebPrefsPath(dir), '{not json');
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: true });
  });

  it('round-trips the off switch and back', () => {
    expect(saveWebPrefs(dir, { inlineImages: false })).toBe(true);
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: false });
    expect(saveWebPrefs(dir, { inlineImages: true })).toBe(true);
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: true });
  });

  it('survives an operator stop, which deletes the server record', () => {
    expect(saveWebPrefs(dir, { inlineImages: false })).toBe(true);
    fs.writeFileSync(getWebStatePath(dir), '{}');
    clearWebState(dir);
    expect(fs.existsSync(getWebStatePath(dir))).toBe(false);
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: false });
  });

  it('remembers the popover port next to the image switch, and ignores a bad one', () => {
    expect(saveWebPrefs(dir, { inlineImages: false, port: 7690 })).toBe(true);
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: false, port: 7690 });
    expect(saveWebPrefs(dir, { ...loadWebPrefs(dir), inlineImages: true })).toBe(true);
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: true, port: 7690 });
    fs.writeFileSync(getWebPrefsPath(dir), JSON.stringify({ version: 1, inlineImages: true, port: 80 }));
    expect(loadWebPrefs(dir)).toEqual({ inlineImages: true });
  });
});
