// @wmux-lane unit
// Pure functions over the theme tokens: "win32" appears only in a regex that
// reads globals.css as text, so Windows cannot change the result.
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
  WINDOWS_GLASS_FLOOR,
  glassContrast,
  windowsGlassCoverage,
  worstBackdrop,
  type GlassCoverage,
  type GlassTokens,
} from '../glassCoverage';

const THEMES = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

/** `--frame-bg` as globals.css resolves it: the look's frame knob, else `--app-bg` (84% / 97% of the base over black). */
function frameOf(id: BuiltinThemeId): string {
  const { bgBase } = deriveBuiltinPalette(id);
  return THEME_STYLES[id]?.frame ?? mixHex('#000000', bgBase, isLight(bgBase) ? 0.97 : 0.84);
}

/** The tokens the renderer's gate reads: the look's own, the same text glass draws. */
function tokensOf(id: BuiltinThemeId): GlassTokens {
  const p = deriveBuiltinPalette(id);
  return {
    frameBg: frameOf(id), mantle: p.bgMantle,
    textMain: p.textMain, textSub2: p.textSub2, textSub: p.textSub, textSubtle: p.textSubtle, textMuted: p.textMuted,
  };
}

/** Fixed tokens with the in-between tiers derived as deriveFullPalette does. */
function derived(t: Omit<GlassTokens, 'textSub2' | 'textSubtle'>): GlassTokens {
  return { ...t, textSub2: mixHex(t.textMain, t.textSub, 0.5), textSubtle: mixHex(t.textSub, t.textMuted, 0.5) };
}

function appearanceOf(id: BuiltinThemeId): 'dark' | 'light' {
  return isLight(deriveBuiltinPalette(id).bgBase) ? 'light' : 'dark';
}

// Invariants, not per-look outcomes: a token edit may move a look in or out of
// glass, and these still hold.
function meets(tokens: GlassTokens, appearance: 'dark' | 'light', coverage: GlassCoverage): boolean {
  const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
  return (Object.keys(GLASS_MIN_CONTRAST) as Array<keyof typeof GLASS_MIN_CONTRAST>).every((tier) => c[tier] >= GLASS_MIN_CONTRAST[tier]);
}

describe('windowsGlassCoverage over every built-in look', () => {
  for (const id of THEMES) {
    for (const level of ['soft', 'clear'] as const) {
      it(`${id} ${level}: glass is legible and minimal over the worst backdrop, or no coverage in range is`, () => {
        const appearance = appearanceOf(id);
        const tokens = tokensOf(id);
        const floor = WINDOWS_GLASS_FLOOR[appearance][level];
        const coverage = windowsGlassCoverage(tokens, appearance, level);
        if (coverage) {
          expect(coverage.sheet).toBe(floor.sheet);
          expect(coverage.frame).toBeGreaterThanOrEqual(floor.frame);
          expect(coverage.frame).toBeLessThanOrEqual(GLASS_MAX_COVERAGE);
          // Every target, in the frame and the sidebar.
          const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
          for (const [tier, floor] of Object.entries(GLASS_MIN_CONTRAST) as Array<[keyof typeof GLASS_MIN_CONTRAST, number]>) {
            expect(c[tier], `${id} ${level} ${tier}`).toBeGreaterThanOrEqual(floor);
          }
          // The smallest such frame: one step less misses a target.
          if (coverage.frame > floor.frame) {
            expect(meets(tokens, appearance, { ...coverage, frame: coverage.frame - 1 })).toBe(false);
          }
        } else {
          for (let frame = floor.frame; frame <= GLASS_MAX_COVERAGE; frame++) {
            expect(meets(tokens, appearance, { frame, sheet: floor.sheet }), `${frame}%`).toBe(false);
          }
        }
      });
    }
  }

  it('Soft never covers less than Clear', () => {
    for (const id of THEMES) {
      const soft = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'soft');
      const clear = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'clear');
      if (!soft || !clear) continue;
      expect(soft.frame).toBeGreaterThanOrEqual(clear.frame);
      expect(soft.sheet).toBeGreaterThanOrEqual(clear.sheet);
    }
  });
});

describe('windowsGlassCoverage on fixed tokens', () => {
  // The dark Tint look's colours as of 2026-10-21, pinned here so the
  // numbers do not move with the theme tokens.
  const fixed: GlassTokens = derived({ frameBg: '#121015', mantle: '#18151C', textMain: '#F4F2F7', textSub: '#C2BDC9', textMuted: '#8A8492' });

  it('raises the frame to the smallest legible value and keeps the sheet at its floor', () => {
    expect(windowsGlassCoverage(fixed, 'dark', 'soft')).toEqual({ frame: 82, sheet: 6 });
    expect(windowsGlassCoverage(fixed, 'dark', 'clear')).toEqual({ frame: 82, sheet: 5 });
  });

  it('measures the old fixed 30%/6% as illegible over a white window', () => {
    expect(glassContrast(fixed, '#FFFFFF', { frame: 30, sheet: 6 }).sub).toBeLessThan(GLASS_MIN_CONTRAST.sub);
  });

  it('judges the in-between tiers too: a sub2 or subtle the cap cannot keep legible makes the look opaque', () => {
    // The same look with one in-between tier set to its sub or muted neighbour's
    // colour dimmed past the floor: main, sub and muted alone would still pass.
    expect(windowsGlassCoverage({ ...fixed, textSub2: '#6E6A73' }, 'dark', 'soft')).toBeNull();
    expect(windowsGlassCoverage({ ...fixed, textSubtle: '#4A4650' }, 'dark', 'soft')).toBeNull();
  });
});

describe('windowsGlassCoverage fallback', () => {
  it('is null (opaque) for a look whose text no coverage in the range keeps legible', () => {
    // Mid-grey text on a near-black frame: even the full 90% leaves it under 3:1 over white.
    const murky: GlassTokens = derived({ frameBg: '#101010', mantle: '#101010', textMain: '#FFFFFF', textSub: '#BBBBBB', textMuted: '#444444' });
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
    // Any rule gated on win32, whatever its attribute order, that sets a coverage.
    expect(css).not.toMatch(/\[data-platform="win32"\][^{}]*\{[^}]*--glass-(frame|sheet)\s*:/);
  });
});

// Owner decision 2026-10-22: Windows glass draws its text the way macOS glass
// does, from the look's own tiers, with the same row fills. No platform rule
// may restate a text colour, so glass and glass Off, on either platform, draw
// the same text.
describe("glass draws the look's own text", () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');

  it('no rule outside the theme blocks restates a text colour tier', () => {
    const themeBlock = /^(:root,\s*)?(:root)?\[data-theme="[^"]+"\]$/;
    const offenders: string[] = [];
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      // The text colour tiers (not the --text-<size> type scale).
      if (/--text-(?:main|sub2|sub|subtle|muted)\s*:/.test(m[2]) && !themeBlock.test(selector)) offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });
});
