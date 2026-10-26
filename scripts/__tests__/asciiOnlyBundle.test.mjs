import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import { asciiOnlyBundle, escapeRegexLiteral, escapeRegexesAndComments } from '../lib/ascii-only-bundle.mjs';

const isOneByte = (text) => !/[\u0100-\uffff]/.test(text);
const NBSP = String.fromCharCode(0xa0);
const LS = String.fromCharCode(0x2028);
const isAscii = (text) => /^[\x20-\x7e\n]*$/.test(text);

// Builds the escaped literal back into a RegExp, the way the engine reads it.
const compile = (literal) => {
  const end = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, end), literal.slice(end + 1));
};

describe('escapeRegexLiteral', () => {
  const cases = [
    // [literal, probes]
    ['/[가-힣]+/', ['한글', 'abc', '가', 'ㄱ']],
    ['/^(con|com[0-9¹²³])$/i', ['com¹', 'COM³', 'com4']],
    ['/[⎿⏺●]\\s*/', ['● x', '⏺', '-']],
    ['/\\→/', ['a→b', 'a-b']],
    ['/\\\\→/', ['\\→', '→']],
    ['/😀+/', ['😀', '\uD83D\uDE00\uDE00', 'x']],
    ['/^[😀-😎]$/u', ['😀', '😊', '😏', '\uD83D']],
    ['/(?<名>a)/', ['a']],
    ['/[\\p{L}→]/v', ['→', 'x', '1']],
  ];

  it.each(cases)('%s keeps its matches and comes out ASCII', (literal, probes) => {
    const escaped = escapeRegexLiteral(literal);
    expect(isAscii(escaped)).toBe(true);
    const before = compile(literal);
    const after = compile(escaped);
    expect(after.flags).toBe(before.flags);
    for (const probe of probes) {
      expect(after.exec(probe)?.slice(), probe).toEqual(before.exec(probe)?.slice());
      expect(after.exec(probe)?.groups, probe).toEqual(before.exec(probe)?.groups);
    }
  });

  it('drops the backslash of an identity escape instead of escaping it', () => {
    expect(escapeRegexLiteral('/\\→/')).toBe('/\\u2192/');
    expect(escapeRegexLiteral('/\\\\→/')).toBe('/\\\\\\u2192/');
  });
});

describe('escapeRegexesAndComments', () => {
  const run = (code) => escapeRegexesAndComments(code, parseAst(code));

  it('escapes regex literals and comment text at the right offsets', () => {
    const code = 'const a="\\u2192";/* → */const r=/[→]/g,s=x/2/y,t=/^가$/u;// 끝\n';
    expect(run(code)).toBe('const a="\\u2192";/* \\u2192 */const r=/[\\u2192]/g,s=x/2/y,t=/^\\uac00$/u;// \\ub05d\n');
  });

  it('keeps whitespace and line terminators between tokens meaning the same', () => {
    const code = 'let a = 1\u00a0+\u20282;// x\u2028a = 3';
    const out = run(code);
    expect(isOneByte(out)).toBe(true);
    // The U+2028 ends the line comment, so `a = 3` still runs.
    expect(new Function(`${out}; return a;`)()).toBe(3);
  });

  it('handles whitespace and line terminators beside a regex and inside a block comment', () => {
    const code = `let a = /→/g${LS}/* ${NBSP}→ */a = a.test('\\u2192');`;
    const out = run(code);
    expect(isOneByte(out)).toBe(true);
    expect(out).toContain('/\\u2192/g\n');
    expect(new Function(`${out}; return a;`)()).toBe(true);
  });

  it('leaves a hashbang line alone: the OS reads it', () => {
    const code = '#!/opt/→/node\nconst r=/→/;';
    expect(run(code)).toBe('#!/opt/→/node\nconst r=/\\u2192/;');
  });

  it('leaves strings, templates and identifiers to esbuild', () => {
    const code = 'const s="→",t=String.raw`→`;';
    expect(run(code)).toBe(code);
  });
});

describe('asciiOnlyBundle', () => {
  const fail = (message) => {
    throw new Error(message);
  };
  // Runs the plugin's two hooks the way Rollup calls them on one chunk.
  const emit = (fileName, source) => {
    const plugin = asciiOnlyBundle();
    const rendered = plugin.renderChunk.handler.call({ parse: parseAst }, source);
    const code = rendered ? rendered.code : source;
    plugin.generateBundle.call({ error: fail }, {}, { [fileName]: { type: 'chunk', fileName, code } });
    return code;
  };

  it('escapes regex literals and comments in the emitted chunk', () => {
    const code = emit('entry.js', '/*! © 한글 */\nexport const r = /^[가-힣]+ → $/u;');
    expect(code).toContain('/*! © \\ud55c\\uae00 */');
    expect(isOneByte(code)).toBe(true);
    expect(code).toContain('/^[\\uac00-\\ud7a3]+ \\u2192 $/u');
  });

  it('fails the build on a character it cannot escape safely, naming the full code point', () => {
    expect(() => emit('entry.js', 'export const s = String.raw`😀`;')).toThrow(/entry\.js holds U\+1F600/);
  });

  it('lets one-byte characters through and stops at U+0100', () => {
    expect(() => emit('entry.js', 'export const s = String.raw`é`;')).not.toThrow();
    expect(() => emit('entry.js', 'export const s = String.raw`ÿ`;')).not.toThrow();
    expect(() => emit('entry.js', 'export const s = String.raw`Ā`;')).toThrow(/entry\.js holds U\+0100/);
  });

  it('checks emitted worker scripts, which reach the parent build as assets', () => {
    const bundle = { 'w.js': { type: 'asset', fileName: 'w.js', source: new TextEncoder().encode('const s="→";') } };
    expect(() => asciiOnlyBundle().generateBundle.call({ error: fail }, {}, bundle)).toThrow(/w\.js holds U\+2192/);
  });
});
