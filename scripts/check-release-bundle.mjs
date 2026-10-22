#!/usr/bin/env node
// Fails when a packaged wmux ships an e2e fake agent (scripts/fixtures/fake-agents).
//
//   node scripts/check-release-bundle.mjs <packaged output dir, e.g. out>
//
// Walks every file under the directory, and every file inside each app.asar,
// and hands them to shippedFakeAgents (scripts/lib/release-bundle-check-lib.mjs).
// A directory with no app.asar is refused: there is nothing packaged to check.
// Exit 0 when clean; 1 with the offending paths; 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT_DIR, shippedFakeAgents } from './lib/release-bundle-check-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asar = createRequire(import.meta.url)('@electron/asar');

const root = process.argv[2];
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('usage: node scripts/check-release-bundle.mjs <packaged output dir>');
  process.exit(2);
}

const fixtures = new Map(
  fs.readdirSync(path.join(REPO_ROOT, FAKE_AGENT_DIR)).map((name) => [name, fs.readFileSync(path.join(REPO_ROOT, FAKE_AGENT_DIR, name))]),
);

const entries = [];
let archives = 0;
const walk = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    // A symlink is listed, never followed (the .app bundle's framework links).
    if (item.isSymbolicLink()) {
      entries.push({ path: full, read: () => null });
    } else if (item.isDirectory()) {
      walk(full);
    } else if (item.name.endsWith('.asar')) {
      archives++;
      for (const inner of asar.listPackage(full, { isPack: false })) {
        const rel = inner.replace(/^[\\/]+/, '');
        entries.push({
          path: `${full}!/${rel}`,
          read: () => { try { return asar.extractFile(full, rel); } catch { return null; } },
        });
      }
    } else {
      entries.push({ path: full, read: () => fs.readFileSync(full) });
    }
  }
};
walk(root);

if (archives === 0) {
  console.error(`release bundle check: no app.asar under ${root}; package the app first`);
  process.exit(2);
}
const found = shippedFakeAgents(entries, fixtures);
if (found.length > 0) {
  console.error(`release bundle check: FAIL: ${found.length} e2e fake agent file(s) in the package:`);
  for (const p of found) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`release bundle check: ok (${entries.length} files in ${archives} archive(s) and around them, no fake agent)`);
