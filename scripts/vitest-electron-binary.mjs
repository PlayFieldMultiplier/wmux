// Vitest globalSetup: install the Electron binary once, before any worker.
//
// Wired in vitest.config.ts (root, so it runs once per run whatever projects
// or shards it holds) and vitest.runtime.config.ts.
//
// Electron 42 dropped its postinstall: `npm ci` leaves node_modules/electron
// without dist/, and `require('electron')` downloads the binary on first use
// (node_modules/electron/index.js). Under vitest that first use is any test
// file whose import graph reaches `electron` unmocked, so each worker that got
// there before dist/ existed ran its own ~150 MB download into the same
// dist/, mid-test. Installing here makes that the one download of the run, and
// a failed install fails the run here instead of inside some later test.
//
// install.js is Electron's own `install-electron` bin. It returns at once when
// dist/ already holds this version.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export default function setup() {
  const electronDir = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  const { version } = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
  let installed = '';
  try {
    installed = fs.readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
  } catch {
    /* no dist/ yet */
  }
  if (installed !== version) console.log(`[vitest] installing the Electron ${version} binary`);
  const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(
      `Electron ${version} binary install failed (${result.error?.message ?? `exit ${result.status}`}). ` +
        'Delete node_modules/electron/dist and run `npx install-electron`.',
    );
  }
}
