// Owner decision 2026-10-21: on every built-in theme, muted text reads at
// 3:1 and secondary text at 4.5:1 on the theme's own opaque surfaces.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { THEME_STYLES, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId, type FullCssPalette } from '../themes';
import { getContrastRatio, isLight, mixHex } from '../tailwindPalette';

const ids = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

// The selected row's fill (--selection) over `bg`: the look's own fill when
// THEME_STYLES sets one (an opaque hex, or a text-main mix), else the fill
// ladder's text-main mix, 10% on dark themes and 6% on light ones (globals.css).
function selectedRow(id: BuiltinThemeId, p: FullCssPalette, bg: string): string {
  const fill = THEME_STYLES[id]?.selectionFill;
  if (fill?.startsWith('#')) return fill;
  const pct = fill ? /(\d+(?:\.\d+)?)%/.exec(fill)?.[1] : undefined;
  return mixHex(bg, p.textMain, pct ? Number(pct) / 100 : isLight(p.bgBase) ? 0.06 : 0.1);
}

// The surfaces text is drawn on: the sheet (--bg-base), the sidebar column
// (--bg-mantle), the window frame and rail (--frame-bg, which defaults to
// --app-bg: the base mixed 16% toward black on dark themes, 3% on light ones),
// the row hover (--hover-fill, text-main 5%) and the selected row
// (--selection) over the sheet and the column.
function surfaces(id: BuiltinThemeId, p: FullCssPalette): Record<string, string> {
  const frame = THEME_STYLES[id]?.frame ?? mixHex(p.bgBase, '#000000', isLight(p.bgBase) ? 0.03 : 0.16);
  return {
    base: p.bgBase,
    mantle: p.bgMantle,
    frame,
    'hover on base': mixHex(p.bgBase, p.textMain, 0.05),
    'hover on mantle': mixHex(p.bgMantle, p.textMain, 0.05),
    'selected row on base': selectedRow(id, p, p.bgBase),
    'selected row on mantle': selectedRow(id, p, p.bgMantle),
  };
}

const FLOORS: Array<[keyof FullCssPalette, number]> = [
  ['textMuted', 3],
  ['textSubtle', 3],
  ['textSub', 4.5],
  ['textSub2', 4.5],
  ['textMain', 4.5],
];

describe('theme text contrast', () => {
  it.each(ids)('%s: muted text reads at 3:1 and secondary text at 4.5:1 on every surface', (id) => {
    const p = deriveBuiltinPalette(id);
    for (const [token, floor] of FLOORS) {
      for (const [name, bg] of Object.entries(surfaces(id, p))) {
        expect(getContrastRatio(p[token], bg), `${id} ${token} ${p[token]} on ${name} ${bg}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  // Owner decision 2026-10-22: the --selection-hover fill (text-main 15% on
  // dark themes, 10% on light ones: a selected Fleet card, a hovered needs-you
  // row, a hovered chip or button) draws muted text one tier up, in the subtle
  // colour, which reads at 3:1 there. The global tiers are not lifted for it.
  it.each(ids)('%s: muted text drawn as subtle reads at 3:1 on the --selection-hover fill', (id) => {
    const p = deriveBuiltinPalette(id);
    const pct = isLight(p.bgBase) ? 0.1 : 0.15;
    for (const [name, bg] of [['base', p.bgBase], ['mantle', p.bgMantle]] as const) {
      const fill = mixHex(bg, p.textMain, pct);
      expect(getContrastRatio(p.textSubtle, fill), `${id} textSubtle ${p.textSubtle} on --selection-hover over ${name} ${fill}`).toBeGreaterThanOrEqual(3);
    }
  });

  // The --selection-emphasis fill (20% / 14%: an open chip, a pressed or
  // active button) follows the same rule as the hover fill.
  it.each(ids)('%s: muted text drawn as sub reads at 3:1 on the --selection-emphasis fill', (id) => {
    const p = deriveBuiltinPalette(id);
    const pct = isLight(p.bgBase) ? 0.14 : 0.2;
    for (const [name, bg] of [['base', p.bgBase], ['mantle', p.bgMantle]] as const) {
      const fill = mixHex(bg, p.textMain, pct);
      expect(getContrastRatio(p.textSub, fill), `${id} textSub ${p.textSub} on --selection-emphasis over ${name} ${fill}`).toBeGreaterThanOrEqual(3);
    }
  });

  // The tiers stay a ladder: lifting muted must not leave subtle at or below it,
  // nor subtle at or above sub2.
  it.each(ids)('%s: on the sheet, contrast rises from muted to subtle to sub and sub2', (id) => {
    const p = deriveBuiltinPalette(id);
    const on = (c: string) => getContrastRatio(c, p.bgBase);
    expect(on(p.textSubtle), `${id} subtle vs muted`).toBeGreaterThan(on(p.textMuted));
    expect(on(p.textSub), `${id} sub vs subtle`).toBeGreaterThan(on(p.textSubtle));
    expect(on(p.textSub2), `${id} sub2 vs subtle`).toBeGreaterThan(on(p.textSubtle));
  });
});

// Every rule and class that paints --selection-hover also moves muted text up
// to subtle on that surface, so the 3:1 above holds wherever the fill shows.
describe('the --selection-hover fill draws muted text as subtle', () => {
  const root = path.join(__dirname, '..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full);
    return /\.(css|tsx)$/.test(e.name) ? [full] : [];
  });
  const sources = files(root).map((f) => [path.relative(root, f), fs.readFileSync(f, 'utf8')] as const);

  it('every CSS rule with a --selection-hover background sets --text-muted to subtle', () => {
    const rules = sources.filter(([f]) => f.endsWith('.css')).flatMap(([f, css]) =>
      [...css.matchAll(/([^{}]*)\{([^{}]*background(?:-color)?:\s*var\(--selection-hover\)[^{}]*)\}/g)].map((m) => [f, m[1].trim(), m[2]] as const));
    expect(rules.length).toBeGreaterThan(0);
    for (const [f, selector, body] of rules) {
      expect(body, `${f}: ${selector}`).toMatch(/--text-muted:\s*var\(--text-subtle\)/);
    }
  });

  it('every hover:bg-[var(--selection-hover)] class also sets --text-muted to subtle on hover', () => {
    const uses = sources.filter(([f]) => f.endsWith('.tsx')).flatMap(([f, src]) =>
      [...src.matchAll(/hover:bg-\[var\(--selection-hover\)\]/g)].map((m) => [f, src.slice(m.index, m.index + 120)] as const));
    expect(uses.length).toBeGreaterThan(0);
    for (const [f, near] of uses) {
      expect(near, f).toContain('hover:[--text-muted:var(--text-subtle)]');
    }
  });

  // The --selection-emphasis fill is stronger still: muted text draws as sub there.
  it('every CSS rule with a --selection-emphasis background sets --text-muted to sub', () => {
    const rules = sources.filter(([f]) => f.endsWith('.css')).flatMap(([f, css]) =>
      [...css.matchAll(/([^{}]*)\{([^{}]*background(?:-color)?:\s*var\(--selection-emphasis\)[^{}]*)\}/g)].map((m) => [f, m[1].trim(), m[2]] as const));
    expect(rules.length).toBeGreaterThan(0);
    for (const [f, selector, body] of rules) {
      expect(body, `${f}: ${selector}`).toMatch(/--text-muted:\s*var\(--text-sub\)/);
    }
  });

  it('every bg-[var(--selection-emphasis)] class also sets --text-muted to sub', () => {
    const uses = sources.filter(([f]) => f.endsWith('.tsx')).flatMap(([f, src]) =>
      [...src.matchAll(/bg-\[var\(--selection-emphasis\)\]/g)].map((m) => [f, src.slice(m.index, m.index + 80)] as const));
    expect(uses.length).toBeGreaterThan(0);
    for (const [f, near] of uses) {
      expect(near, f).toContain('[--text-muted:var(--text-sub)]');
    }
  });
});
