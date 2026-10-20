// @wmux-lane unit
// 'win32' here is only the platform argument hasRoundedWindowCorners takes;
// the function is pure and reads nothing from the OS.
import { describe, expect, it } from 'vitest';
import { hasRoundedWindowCorners, WINDOWS_ROUNDED_CORNERS_MIN_BUILD } from '../windowCorners';
import { parseWindowsBuildNumber } from '../platform';

describe('hasRoundedWindowCorners', () => {
  it('is always true on macOS, whatever build is passed', () => {
    expect(hasRoundedWindowCorners('darwin', null)).toBe(true);
    expect(hasRoundedWindowCorners('darwin', 19045)).toBe(true);
  });

  it('is true on Windows 11 builds and false on Windows 10 builds', () => {
    expect(WINDOWS_ROUNDED_CORNERS_MIN_BUILD).toBe(22000);
    expect(hasRoundedWindowCorners('win32', 22000)).toBe(true);
    expect(hasRoundedWindowCorners('win32', 26200)).toBe(true);
    expect(hasRoundedWindowCorners('win32', 21999)).toBe(false);
    expect(hasRoundedWindowCorners('win32', 19045)).toBe(false);
  });

  it('keeps the square fallback when the Windows build was not read', () => {
    expect(hasRoundedWindowCorners('win32', null)).toBe(false);
    expect(hasRoundedWindowCorners('win32', undefined)).toBe(false);
  });

  it('is false on Linux and on an unknown platform', () => {
    expect(hasRoundedWindowCorners('linux', null)).toBe(false);
    expect(hasRoundedWindowCorners('linux', 26200)).toBe(false);
    expect(hasRoundedWindowCorners('', null)).toBe(false);
    expect(hasRoundedWindowCorners(undefined, null)).toBe(false);
  });

  it('decides from the same version strings the preload parses', () => {
    expect(hasRoundedWindowCorners('win32', parseWindowsBuildNumber('10.0.26200'))).toBe(true);
    expect(hasRoundedWindowCorners('win32', parseWindowsBuildNumber('10.0.19045'))).toBe(false);
    expect(hasRoundedWindowCorners('win32', parseWindowsBuildNumber('garbage'))).toBe(false);
  });
});
