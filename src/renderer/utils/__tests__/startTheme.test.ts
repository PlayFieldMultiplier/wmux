import { describe, expect, it } from 'vitest';
import { settleStartTheme, startTheme } from '../startTheme';

function fakeRoot(theme: string) {
  const attrs = new Map<string, string>([['data-theme', theme]]);
  return {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    theme: () => attrs.get('data-theme'),
  };
}

describe('startTheme', () => {
  it('shows the light default for a window main started light (#2512)', () => {
    expect(startTheme('light', 'tint')).toBe('paper');
  });

  it('shows the dark default for a window started dark', () => {
    expect(startTheme('dark', 'tint')).toBe('tint');
  });

  it('falls back to the store default without a polarity', () => {
    expect(startTheme(null, 'tint')).toBe('tint');
    expect(startTheme(undefined, 'tint')).toBe('tint');
  });
});

describe('settleStartTheme', () => {
  it('puts the store theme back when the session restored none', () => {
    const root = fakeRoot('paper');
    settleStartTheme(root, 'paper', 'tint');
    expect(root.theme()).toBe('tint');
  });

  it('leaves a restored theme alone', () => {
    const root = fakeRoot('graphite');
    settleStartTheme(root, 'paper', 'graphite');
    expect(root.theme()).toBe('graphite');
  });

  it('leaves a restored theme alone that matches the start theme', () => {
    const root = fakeRoot('paper');
    settleStartTheme(root, 'paper', 'paper');
    expect(root.theme()).toBe('paper');
  });
});
