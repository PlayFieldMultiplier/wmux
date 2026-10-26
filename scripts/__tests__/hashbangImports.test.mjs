// No test, vitest config or setup file loads a JavaScript file that starts
// with a hashbang (`#!`), directly or through the modules it imports.
//
// Vitest runs every repo module through Vite's SSR transform, which finds the
// hashbang with /^#!.*\n/. On a CRLF checkout (core.autocrlf=true: Windows,
// this project's primary platform, and the Windows CI runners) the line ends
// in `\r\n`, the pattern misses it, the imports are hoisted above the `#!`
// line, and the module fails to load with "SyntaxError: Invalid or unexpected
// token". An LF checkout passes, so only the Windows nightly sees it (#2769).
// TypeScript is compiled before that transform and comes out with LF line
// ends, so only plain JavaScript (.js, .mjs, .cjs) is affected; a test may
// import a .ts entry point such as src/mcp/index.ts.
// A command-line script keeps its logic in a module without a hashbang
// (scripts/lib/) and imports it; tests import that module, or spawn the script.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listTestFiles } from '../lib/test-lanes.mjs';

// Relative specifiers of static imports and re-exports, side-effect imports,
// and dynamic imports of a string literal: every form Vite transforms.
const SPECIFIER = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'];
// A vitest config names its setup and global setup files as strings; those
// load through the same transform as an import.
const SETUP_FILES = /\b(?:setupFiles|globalSetup)\s*:\s*\[([^\]]*)\]/g;
const QUOTED_RELATIVE = /['"](\.{1,2}\/[^'"]+)['"]/g;

const isFile = (abs) => {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};

/** The file a relative specifier names, as TypeScript and Vite resolve it, or null. */
function resolve(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec.split('?')[0]);
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  // `./x.js` in TypeScript source names x.ts.
  if (/\.[cm]?js$/.test(base)) candidates.push(...['.ts', '.tsx', '.mts'].map((ext) => base.replace(/\.[cm]?js$/, ext)));
  return candidates.find(isFile) ?? null;
}

describe('hashbang files reached from tests', () => {
  it('none: a test imports the module a script uses, not the script', () => {
    const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
    // The import chain that first reached each file, for the message.
    const via = new Map();
    const queue = [];
    const configs = fs.readdirSync(ROOT).filter((name) => /^vitest\b.*\.[cm]?[jt]s$/.test(name));
    for (const start of [...listTestFiles(), ...configs]) {
      const abs = path.join(ROOT, start);
      via.set(abs, [start]);
      queue.push(abs);
    }
    const hits = [];
    while (queue.length) {
      const abs = queue.shift();
      if (!/\.(?:[cm]?[jt]sx?)$/.test(abs) || abs.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const source = fs.readFileSync(abs, 'utf8');
      if (/\.[cm]?js$/.test(abs) && source.startsWith('#!')) {
        hits.push(`${via.get(abs).join(' -> ')} starts with a hashbang`);
        continue;
      }
      const specs = [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3]);
      for (const [, list] of source.matchAll(SETUP_FILES)) specs.push(...[...list.matchAll(QUOTED_RELATIVE)].map((m) => m[1]));
      for (const spec of specs) {
        const target = resolve(abs, spec);
        if (!target || via.has(target)) continue;
        via.set(target, [...via.get(abs), rel(target)]);
        queue.push(target);
      }
    }
    expect(hits.join('\n')).toBe('');
    // The walk reaches well past the test files; a handful would mean the
    // specifier pattern stopped matching.
    expect(via.size).toBeGreaterThan(listTestFiles().length + 500);
    // A planted hashbang in a global setup file stops Vitest before this test
    // runs, so check the walk reaches one instead.
    expect(via.has(path.join(ROOT, 'scripts', 'vitest-electron-binary.mjs'))).toBe(true);
  });
});
