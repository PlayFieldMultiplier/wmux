import { defineConfig } from 'vite';
import { asciiOnlyBundle } from './scripts/lib/ascii-only-bundle.mjs';

export default defineConfig({
  // ASCII-only output: one character above one byte makes V8 keep the whole
  // script source as UTF-16 (scripts/lib/ascii-only-bundle.mjs).
  esbuild: { charset: 'ascii' },
  plugins: [asciiOnlyBundle()],
  resolve: {
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
