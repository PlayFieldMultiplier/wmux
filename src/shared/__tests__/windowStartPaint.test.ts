import { describe, expect, it } from 'vitest';
import {
  WINDOW_START_COLORS,
  resolveStartPolarity,
  startPaintCss,
  startPolarity,
  startPolarityArg,
  startPolarityFromArgv,
} from '../windowStartPaint';

describe('startPolarity', () => {
  it('keeps a saved light polarity', () => {
    expect(startPolarity('light')).toBe('light');
  });

  it.each(['dark', undefined, null, 'system', 42, { theme: 'light' }])('starts dark, the default theme\'s, for %j', (saved) => {
    expect(startPolarity(saved)).toBe('dark');
  });
});

describe('the polarity argument', () => {
  it.each(['dark', 'light'] as const)('round-trips %s through the renderer argv', (polarity) => {
    expect(startPolarityFromArgv(['electron', '--type=renderer', startPolarityArg(polarity), '--other'])).toBe(polarity);
  });

  it('reads nothing without the argument, or from a value it does not know', () => {
    expect(startPolarityFromArgv(['electron', '--type=renderer'])).toBeNull();
    expect(startPolarityFromArgv(undefined)).toBeNull();
    expect(startPolarityFromArgv(['--wmux-start-polarity=system'])).toBeNull();
    expect(startPolarityFromArgv(['--wmux-start-polarity=light;}body{x:y'])).toBeNull();
  });
});

describe('startPaintCss', () => {
  it.each(['dark', 'light'] as const)('paints the %s start colour only before a theme is set', (polarity) => {
    expect(startPaintCss(polarity)).toBe(`:root:not([data-theme]) { --bg-base: ${WINDOW_START_COLORS[polarity].background}; }`);
  });
});

describe('resolveStartPolarity', () => {
  const argv = ['electron', startPolarityArg('light')];

  it('takes the polarity a reload recorded over the one the window was built with', () => {
    expect(resolveStartPolarity('dark', argv)).toBe('dark');
  });

  it('takes the window\'s polarity on its first load, or when the record is not one it knows', () => {
    expect(resolveStartPolarity(null, argv)).toBe('light');
    expect(resolveStartPolarity('system', argv)).toBe('light');
    expect(resolveStartPolarity(undefined, ['electron'])).toBeNull();
  });
});
