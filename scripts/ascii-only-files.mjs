#!/usr/bin/env node
// Runs the ASCII-only step (scripts/lib/ascii-only-files.mjs) on the bundles
// esbuild writes straight to disk: the daemon, the CLI and the MCP server.
//
// Usage: node scripts/ascii-only-files.mjs <file.js>...

import { asciiOnlyFiles } from './lib/ascii-only-files.mjs';

asciiOnlyFiles(process.argv.slice(2));
