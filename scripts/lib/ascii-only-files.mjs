// The ASCII-only step for the bundles esbuild writes straight to disk: the
// daemon, the CLI and the MCP server (Vite builds use the plugin in
// ascii-only-bundle.mjs instead).
// esbuild's default charset already escapes strings, templates and
// identifiers; this rewrites what it prints as written (comments, which an
// unminified bundle keeps, and regex literals), then fails the build if a
// character above U+00FF is left, since one such character makes V8 keep the
// whole source as UTF-16.
//
// The CLI is scripts/ascii-only-files.mjs. This module has no hashbang so a
// test can import it: on a CRLF checkout Vite's SSR transform does not see a
// `#!...\r\n` line as the hashbang and hoists the imports above it, and the
// module then fails to load with "Invalid or unexpected token".

import { readFileSync, writeFileSync } from 'node:fs';
import { parseAst } from 'vite';
import { escapeRegexesAndComments, firstWideChar, wideCharMessage } from './ascii-only-bundle.mjs';

export function asciiOnlyFiles(files) {
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    if (!firstWideChar(code)) continue;
    let ast;
    try {
      // A CommonJS file may return at top level.
      ast = parseAst(code, { allowReturnOutsideFunction: true });
    } catch (err) {
      // Rollup's parser cannot read some sloppy-mode code (a `with` statement).
      throw new Error(`${file}: the parser could not read this file, so its comments and regex literals cannot be escaped: ${err.message}`);
    }
    const out = escapeRegexesAndComments(code, ast);
    const hit = firstWideChar(out);
    if (hit) throw new Error(wideCharMessage(file, hit));
    writeFileSync(file, out);
  }
}
