import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { parseWindowsBuildNumber } from '../platform';
import { isWindowGlassSupported, resolveWindowGlass, WINDOWS_GLASS_MIN_BUILD } from '../windowGlass';

describe('isWindowGlassSupported', () => {
  it('is on for Windows 11 22H2 and later', () => {
    expect(WINDOWS_GLASS_MIN_BUILD).toBe(22621);
    expect(isWindowGlassSupported('win32', 22621)).toBe(true);
    expect(isWindowGlassSupported('win32', 26200)).toBe(true);
  });

  it('is off for Windows 10 and Windows 11 before 22H2', () => {
    expect(isWindowGlassSupported('win32', 19045)).toBe(false);
    expect(isWindowGlassSupported('win32', 22000)).toBe(false);
    expect(isWindowGlassSupported('win32', 22620)).toBe(false);
  });

  it('is off on Windows when the build could not be read', () => {
    expect(isWindowGlassSupported('win32', null)).toBe(false);
    expect(isWindowGlassSupported('win32', undefined)).toBe(false);
  });

  it('is on for macOS whatever the build, and off for Linux and unknown platforms', () => {
    expect(isWindowGlassSupported('darwin', null)).toBe(true);
    expect(isWindowGlassSupported('linux', 26200)).toBe(false);
    expect(isWindowGlassSupported(undefined, 26200)).toBe(false);
  });

  it('agrees with this machine\'s os.release() read through parseWindowsBuildNumber', () => {
    if (process.platform !== 'win32') return;
    const build = parseWindowsBuildNumber(os.release());
    expect(build).not.toBeNull();
    expect(isWindowGlassSupported('win32', build)).toBe((build ?? 0) >= 22621);
  });
});

describe('resolveWindowGlass', () => {
  it('keeps a known level and falls back to Soft otherwise', () => {
    expect(resolveWindowGlass('off')).toBe('off');
    expect(resolveWindowGlass('clear')).toBe('clear');
    expect(resolveWindowGlass(null)).toBe('soft');
    expect(resolveWindowGlass('acrylic')).toBe('soft');
  });
});
