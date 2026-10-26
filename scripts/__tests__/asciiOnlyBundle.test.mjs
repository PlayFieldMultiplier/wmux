import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import { asciiOnlyBundle, escapeRegexLiteral, escapeRegexLiterals, firstNonAscii } from '../lib/ascii-only-bundle.mjs';

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
    expect(firstNonAscii(escaped)).toBeNull();
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

describe('escapeRegexLiterals', () => {
  it('rewrites only regex literals, at the right offsets after earlier wide characters', () => {
    const code = 'const a="\\u2192";/* → */const r=/[→]/g,s=x/2/y,t=/^가$/u;';
    const out = escapeRegexLiterals(code, parseAst(code));
    expect(out).toBe('const a="\\u2192";/* → */const r=/[\\u2192]/g,s=x/2/y,t=/^\\uac00$/u;');
  });
});

describe('asciiOnlyBundle', () => {
  // Runs the plugin's two hooks the way Rollup calls them on one chunk.
  const emit = (fileName, source) => {
    const plugin = asciiOnlyBundle();
    const rendered = plugin.renderChunk.handler.call({ parse: parseAst }, source);
    const code = rendered ? rendered.code : source;
    const fail = (message) => {
      throw new Error(message);
    };
    plugin.generateBundle.call({ error: fail }, {}, { [fileName]: { type: 'chunk', fileName, code } });
    return code;
  };

  it('escapes regex literals in the emitted chunk', () => {
    const code = emit('entry.js', 'export const r = /^[가-힣]+ → $/u;');
    expect(firstNonAscii(code)).toBeNull();
    expect(code).toContain('/^[\\uac00-\\ud7a3]+ \\u2192 $/u');
  });

  it('fails the build on a character it cannot escape safely', () => {
    expect(() => emit('entry.js', 'export const s = String.raw`→`;')).toThrow(/entry\.js holds a non-ASCII character \(U\+2192\)/);
  });

  it('checks emitted worker scripts, which reach the parent build as assets', () => {
    const plugin = asciiOnlyBundle();
    const fail = (message) => {
      throw new Error(message);
    };
    const bundle = { 'w.js': { type: 'asset', fileName: 'w.js', source: new TextEncoder().encode('const s="→";') } };
    expect(() => plugin.generateBundle.call({ error: fail }, {}, bundle)).toThrow(/w\.js holds/);
  });
});
