#!/usr/bin/env node
// The ASCII-only step for the scripts esbuild writes or copy-bridge copies
// straight to disk: the daemon, the CLI and its bridges, and the MCP server
// (Vite builds use the plugin in scripts/lib/ascii-only-bundle.mjs instead).
// esbuild's default charset already escapes strings, templates and
// identifiers; this rewrites what it prints as written (comments, which an
// unminified bundle keeps, and regex literals), then fails the build if a
// character above U+00FF is left, since one such character makes V8 keep the
// whole source as UTF-16.
//
// Usage: node scripts/ascii-only-files.mjs <file.js>...

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'vite';
import { escapeRegexesAndComments, firstWideChar, wideCharMessage } from './lib/ascii-only-bundle.mjs';

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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) asciiOnlyFiles(process.argv.slice(2));
