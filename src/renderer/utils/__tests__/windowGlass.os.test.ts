import { describe, it, expect } from 'vitest';
import { resolveWindowGlass, shouldUseGlass, themeAppearance } from '../windowGlass';

describe('shouldUseGlass', () => {
  it('is on for a dark theme once the appearance is dark', () => {
    expect(shouldUseGlass('darwin', '#171717', '1', true)).toBe(true);
  });

  it('is on for a light theme once the appearance is light', () => {
    expect(shouldUseGlass('darwin', '#F7F7F7', '1', false)).toBe(true);
  });

  it('stays off while the appearance does not match the theme yet', () => {
    expect(shouldUseGlass('darwin', '#1A171D', '1', false)).toBe(false);
    expect(shouldUseGlass('darwin', '#F7F7F7', '1', true)).toBe(false);
  });

  it('is on for Windows 11 22H2 and later, where the window has acrylic', () => {
    expect(shouldUseGlass('win32', '#171717', '1', true, 'soft', 26200)).toBe(true);
    expect(shouldUseGlass('win32', '#F7F7F7', '1', false, 'clear', 22621)).toBe(true);
    expect(shouldUseGlass('win32', '#171717', '1', true, 'off', 26200)).toBe(false);
    expect(shouldUseGlass('win32', '#171717', '1', false, 'soft', 26200)).toBe(false);
  });

  it('is off on Windows 10, older Windows 11, an unread build and Linux whatever the theme', () => {
    expect(shouldUseGlass('win32', '#171717')).toBe(false);
    expect(shouldUseGlass('win32', '#171717', '1', true, 'soft', 19045)).toBe(false);
    expect(shouldUseGlass('win32', '#171717', '1', true, 'soft', 22000)).toBe(false);
    expect(shouldUseGlass('linux', '#171717', '1', true, 'soft', 26200)).toBe(false);
    expect(shouldUseGlass(undefined, '#171717')).toBe(false);
  });

  it('is off when the theme opts out of glass', () => {
    expect(shouldUseGlass('darwin', '#09090B', '0')).toBe(false);
    expect(shouldUseGlass('darwin', '#1A171D', '1')).toBe(true);
  });

  it('is off when the user turns glass off', () => {
    expect(shouldUseGlass('darwin', '#1A171D', '1', true, 'off')).toBe(false);
    expect(shouldUseGlass('darwin', '#1A171D', '1', true, 'clear')).toBe(true);
  });

  it('is off when the base colour cannot be read', () => {
    expect(shouldUseGlass('darwin', '')).toBe(false);
    expect(shouldUseGlass('darwin', ' #171717 ')).toBe(true);
  });
});

describe('themeAppearance', () => {
  it('reads the polarity from the base colour', () => {
    expect(themeAppearance('#1A171D')).toBe('dark');
    expect(themeAppearance('#FFFFFF')).toBe('light');
    expect(themeAppearance('var(--x)')).toBeNull();
  });
});

describe('resolveWindowGlass', () => {
  it('keeps a known level and falls back to Soft otherwise', () => {
    expect(resolveWindowGlass('clear')).toBe('clear');
    expect(resolveWindowGlass('off')).toBe('off');
    expect(resolveWindowGlass('transparent')).toBe('soft');
    expect(resolveWindowGlass(undefined)).toBe('soft');
  });
});
