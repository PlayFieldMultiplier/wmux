// Windows glass coverage is derived from each look's tokens so its text stays
// legible over the worst backdrop (owner decision 2026-10-21). These run the
// real built-in tokens through the same composite the page paints.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { THEME_STYLES, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId } from '../../themes';
import { isLight, mixHex } from '../../tailwindPalette';
import {
  GLASS_MAX_COVERAGE,
  GLASS_MIN_CONTRAST,
  glassContrast,
  windowsGlassCoverage,
  worstBackdrop,
  type GlassTokens,
} from '../glassCoverage';

const THEMES = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

/** `--frame-bg` as globals.css resolves it: the look's frame knob, else `--app-bg` (84% / 97% of the base over black). */
function frameOf(id: BuiltinThemeId): string {
  const { bgBase } = deriveBuiltinPalette(id);
  return THEME_STYLES[id]?.frame ?? mixHex('#000000', bgBase, isLight(bgBase) ? 0.97 : 0.84);
}

function tokensOf(id: BuiltinThemeId): GlassTokens {
  const p = deriveBuiltinPalette(id);
  return { frameBg: frameOf(id), mantle: p.bgMantle, textMain: p.textMain, textSub: p.textSub, textMuted: p.textMuted };
}

function appearanceOf(id: BuiltinThemeId): 'dark' | 'light' {
  return isLight(deriveBuiltinPalette(id).bgBase) ? 'light' : 'dark';
}

describe('windowsGlassCoverage over every built-in look', () => {
  for (const id of THEMES) {
    for (const level of ['soft', 'clear'] as const) {
      it(`${id} ${level}: legible over the worst backdrop in the frame and the sidebar, or opaque`, () => {
        const appearance = appearanceOf(id);
        const coverage = windowsGlassCoverage(tokensOf(id), appearance, level);
        if (!coverage) return;
        expect(coverage.frame).toBeLessThanOrEqual(GLASS_MAX_COVERAGE);
        const c = glassContrast(tokensOf(id), worstBackdrop(appearance), coverage);
        expect(c.main).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.main);
        expect(c.sub).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.sub);
        expect(c.muted).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.muted);
      });
    }
  }

  it('keeps glass on exactly these looks (a token edit that flips one shows up here)', () => {
    const glassy = THEMES.filter((id) => windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'soft'));
    expect(glassy.sort()).toEqual(['amber-line', 'graphite', 'hinomaru', 'taegeuk', 'tint', 'zinc']);
    for (const id of THEMES) {
      expect(!!windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'clear')).toBe(glassy.includes(id));
    }
  });

  it('never goes below the level floor, and Soft never covers less than Clear', () => {
    for (const id of THEMES) {
      const soft = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'soft');
      const clear = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'clear');
      if (!soft || !clear) continue;
      expect(soft.frame).toBeGreaterThanOrEqual(clear.frame);
      expect(soft.sheet).toBeGreaterThanOrEqual(clear.sheet);
      const floor = appearanceOf(id) === 'dark' ? { frame: 12, sheet: 5 } : { frame: 35, sheet: 8 };
      expect(clear.frame).toBeGreaterThanOrEqual(floor.frame);
      expect(clear.sheet).toBeGreaterThanOrEqual(floor.sheet);
    }
  });

  it('is the smallest legible frame: one step less is not legible', () => {
    const coverage = windowsGlassCoverage(tokensOf('tint'), 'dark', 'soft');
    if (!coverage) throw new Error('tint keeps glass on Windows');
    const below = glassContrast(tokensOf('tint'), '#FFFFFF', { ...coverage, frame: coverage.frame - 1 });
    expect(
      below.main >= GLASS_MIN_CONTRAST.main && below.sub >= GLASS_MIN_CONTRAST.sub && below.muted >= GLASS_MIN_CONTRAST.muted,
    ).toBe(false);
  });
});

describe('windowsGlassCoverage fallback', () => {
  it('is null (opaque) for a look whose text no coverage in the range keeps legible', () => {
    // Mid-grey text on a near-black frame: even the full 90% leaves it under 3:1 over white.
    const murky: GlassTokens = { frameBg: '#101010', mantle: '#101010', textMain: '#FFFFFF', textSub: '#BBBBBB', textMuted: '#444444' };
    expect(windowsGlassCoverage(murky, 'dark', 'soft')).toBeNull();
    expect(windowsGlassCoverage(murky, 'dark', 'clear')).toBeNull();
  });
});

describe('macOS glass numbers stay in globals.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    return { frame: /--glass-frame:\s*([^;]+);/.exec(body)?.[1], sheet: /--glass-sheet:\s*([^;]+);/.exec(body)?.[1] };
  };
  const hued = ':is([data-theme="stars-and-stripes"], [data-theme="red-dynasty"], [data-theme="catppuccin-mocha"])';

  it('keeps every macOS rule at its number', () => {
    expect(rule('html[data-glass]')).toEqual({ frame: '25%', sheet: '6%' });
    expect(rule('html[data-glass][data-glass-level="clear"]')).toEqual({ frame: '10%', sheet: '5%' });
    expect(rule(`html[data-glass]${hued}`)).toEqual({ frame: '55%', sheet: '20%' });
    expect(rule(`html[data-glass]${hued}[data-glass-level="clear"]`)).toEqual({ frame: '35%', sheet: '12%' });
    expect(rule('html[data-glass="light"]')).toEqual({ frame: '10%', sheet: '4%' });
    expect(rule('html[data-glass="light"][data-glass-level="clear"]')).toEqual({ frame: '0%', sheet: '3%' });
  });

  it('has no fixed Windows numbers left: the renderer derives them', () => {
    expect(css).not.toMatch(/html\[data-glass[^\]]*\]\[data-platform="win32"\]/);
  });
});
