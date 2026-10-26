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
import { RELATIVE_IMPORT, ROOT, isTypeOnlyImport, listTestFiles, resolveRelative } from '../lib/test-lanes.mjs';

// A query that hands the importer the file's text or URL: the file is not run.
const NOT_RUN_QUERY = /\?(?:raw|url|inline)\b/;
// A vitest config names its setup and global setup files as strings; those
// load through the same transform as an import.
const SETUP_FILES = /\b(?:setupFiles|globalSetup)\s*:\s*\[([^\]]*)\]/g;
const QUOTED_RELATIVE = /['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * True when `index` sits in a comment: after `//` on its line, or on a line
 * that opens or continues a block comment (`/*`, ` * `). A glob string such as
 * 'src/**' is no comment, so the file is not scanned for `/*` pairs.
 */
function inComment(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  // Strings out first: a `//` inside one (a URL) opens no comment.
  // A block comment closed earlier on the line (`/* x */ import ...`) is gone too.
  const before = source.slice(lineStart, index).replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '').replace(/\/\*.*?\*\//g, '');
  return before.includes('//') || /^\s*(?:\/\*|\*)/.test(before);
}

/**
 * The relative specifiers a module loads as code, read as the lane rule reads
 * imports (RELATIVE_IMPORT): not a type-only import (TypeScript erases it), not
 * one in a comment, not a `?raw` or `?url` import. A query is dropped.
 */
function loadedSpecifiers(source) {
  const specs = [];
  for (const m of source.matchAll(RELATIVE_IMPORT)) {
    // The opening quote: the match ends with the specifier and its closing quote.
    const quote = m.index + m[0].length - m[1].length - 2;
    if (inComment(source, m.index) || isTypeOnlyImport(source, quote) || NOT_RUN_QUERY.test(m[1])) continue;
    specs.push(m[1].split('?')[0]);
  }
  return specs;
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
      const specs = loadedSpecifiers(source);
      for (const [, list] of source.matchAll(SETUP_FILES)) specs.push(...[...list.matchAll(QUOTED_RELATIVE)].map((m) => m[1]));
      for (const spec of specs) {
        const target = resolveRelative(abs, spec);
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

describe('what the walk counts as a load', () => {
  it('a value import, a re-export, a side-effect import and a literal dynamic import', () => {
    const source = [
      "import { a } from './a.mjs';",
      "export { b } from './b.mjs';",
      "import './c.mjs';",
      "const d = await import('./d.mjs');",
      "import { type T, e } from './e.mjs';",
      "const u = 'https://example.com'; import f from './f.mjs';",
      "import g from './g.mjs?v=1';",
      "/* eslint-disable-next-line */ import { h } from './h.mjs';",
      "import type { T2 } from './t2.mjs';",
      "export { i } from './i.mjs';",
    ].join('\n');
    expect(loadedSpecifiers(source)).toEqual(['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs', './g.mjs', './h.mjs', './i.mjs']);
  });

  it('not a type-only import: TypeScript erases it', () => {
    expect(loadedSpecifiers("import type { T } from './cli.mjs';\nimport { type A, type B } from './cli2.mjs';\n")).toEqual([]);
  });

  it('not an import in a comment', () => {
    const source = [
      "// import { run } from './cli.mjs';",
      '/* import x from \'./cli2.mjs\'; */',
      '/**',
      " * Example: import y from './cli3.mjs';",
      ' */',
      "const z = 1; // was: import z from './cli4.mjs'",
    ].join('\n');
    expect(loadedSpecifiers(source)).toEqual([]);
  });

  it('not a ?raw or ?url import: the file comes back as text or a URL, never run', () => {
    expect(loadedSpecifiers("import text from './cli.mjs?raw';\nimport href from './cli2.mjs?url';\n")).toEqual([]);
  });
});
