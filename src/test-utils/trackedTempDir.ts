import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS, removeTempDirs } from './removeTempDir';

// Temp dirs a test file makes, removed for it through removeTempDir (strict,
// with the bounded wait for an outside holder).
//
// Importing this module registers the hooks on the importing file's root suite.
// They are registered before any of the file's own, so with vitest's stacked
// after-hooks they run after them: a file's afterEach/afterAll that stops what
// writes into its dirs (a child, a timer, a detached run) runs first.
const testDirs: string[] = [];
const fileDirs: string[] = [];
let inTest = false;

beforeEach(() => {
  inTest = true;
});
afterEach(async () => {
  inTest = false;
  await removeTempDirs(testDirs);
}, REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS);
afterAll(() => removeTempDirs(fileDirs), REMOVE_TEMP_DIR_HOOK_TIMEOUT_MS);

/**
 * mkdtemp under os.tmpdir(). Removed after the current test when made inside
 * one (its beforeEach hooks included), otherwise once the file ends;
 * `until: 'file'` keeps it to the end of the file either way.
 */
export function trackedTempDir(prefix: string, opts: { until?: 'test' | 'file' } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  (inTest && opts.until !== 'file' ? testDirs : fileDirs).push(dir);
  return dir;
}
