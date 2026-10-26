#!/usr/bin/env node
// The ASCII-only step for the bundles esbuild writes straight to disk: the
// daemon, the CLI and the MCP server (Vite builds use the plugin in
// scripts/lib/ascii-only-bundle.mjs instead). esbuild's default charset
// already escapes strings, templates and identifiers; this rewrites what it
// prints as written (comments, which an unminified bundle keeps, and regex
// literals), then fails the build if a character above U+00FF is left, since
// one such character makes V8 keep the whole source as UTF-16.
//
// Usage: node scripts/ascii-only-files.mjs <file.js>...

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'vite';
import { escapeRegexesAndComments, firstWideChar } from './lib/ascii-only-bundle.mjs';

export function asciiOnlyFiles(files) {
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    if (!firstWideChar(code)) continue;
    const out = escapeRegexesAndComments(code, parseAst(code));
    const hit = firstWideChar(out);
    if (hit) {
      throw new Error(
        `${file} holds U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')} at ${hit.at}: ${JSON.stringify(hit.context)}. ` +
          'Did its esbuild call set charset=utf8? See scripts/lib/ascii-only-bundle.mjs.',
      );
    }
    writeFileSync(file, out);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) asciiOnlyFiles(process.argv.slice(2));
