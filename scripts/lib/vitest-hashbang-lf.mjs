// Vite plugin for every vitest config: a JavaScript file whose first line is a
// hashbang ending in CRLF has that one line ending turned into LF before Vite
// transforms it.
//
// Vite's SSR transform, which Vitest runs every repo module through, finds a
// hashbang with /^#!.*\n/. On a CRLF checkout (core.autocrlf=true: Windows,
// this project's primary platform, and the Windows CI runners) the line ends
// in `\r\n`, the pattern misses it, the module's imports are hoisted above the
// `#!` line and it fails to load with "SyntaxError: Invalid or unexpected
// token" (#2769). The SSR transform runs after the plugin pipeline, so a `pre`
// plugin fixes its input for every suite, however the file is reached. Only
// plain JavaScript is affected: TypeScript comes out of its own compile step
// with LF line ends. No line moves, so positions after line 1 are unchanged.
//
// scripts/__tests__/hashbangImports.test.mjs stays as a second check: a test
// still imports the module a script uses, not the script.

const JAVASCRIPT = /\.[cm]?js$/;
const CRLF_HASHBANG = /^#![^\n]*\r\n/;

export const HASHBANG_LF_PLUGIN = 'wmux:hashbang-lf';

/**
 * The source with a CRLF hashbang line ended in LF, or null when it has none.
 * @param {string} code
 * @param {string} id
 * @returns {string | null}
 */
export function hashbangToLf(code, id) {
  if (!JAVASCRIPT.test(id.split('?')[0]) || !code.startsWith('#!')) return null;
  const line = CRLF_HASHBANG.exec(code);
  if (!line) return null;
  return `${line[0].slice(0, -2)}\n${code.slice(line[0].length)}`;
}

/** @returns {import('vite').Plugin} */
export function hashbangLf() {
  return {
    name: HASHBANG_LF_PLUGIN,
    enforce: 'pre',
    transform(code, id) {
      const fixed = hashbangToLf(code, id);
      return fixed === null ? null : { code: fixed, map: null };
    },
  };
}
