#!/usr/bin/env node
// Fails when a packaged wmux ships an e2e fake agent (scripts/fixtures/fake-agents).
//
//   node scripts/check-release-bundle.mjs <packaged output dir, e.g. out>
//
// Walks every file under the directory, and every file inside each .asar, and
// hands them to shippedFakeAgents (scripts/lib/release-bundle-check-lib.mjs).
// A symlink whose target is inside the directory is followed (each real path
// once, so a cycle ends); one that cannot be resolved or read fails the check,
// as does an archive file that cannot be read.
// A directory with no app.asar is refused: there is nothing packaged to check.
// Exit 0 when clean; 1 with the offending paths; 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT_DIR, indexFixtures, pathNamesFakeAgent, shippedFakeAgents } from './lib/release-bundle-check-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asar = createRequire(import.meta.url)('@electron/asar');

const root = process.argv[2];
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('usage: node scripts/check-release-bundle.mjs <packaged output dir>');
  process.exit(2);
}

const fixtures = new Map();
const loadFixtures = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) loadFixtures(full);
    else if (item.isFile()) fixtures.set(item.name, fs.readFileSync(full));
  }
};
loadFixtures(path.join(REPO_ROOT, FAKE_AGENT_DIR));
if (fixtures.size === 0) {
  console.error(`release bundle check: no fixture under ${FAKE_AGENT_DIR}; nothing to compare against`);
  process.exit(2);
}

const rootReal = fs.realpathSync(root);
const insideRoot = (real) => {
  const rel = path.relative(rootReal, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const index = indexFixtures(fixtures);
const entries = [];
const visited = new Set();
let archives = 0;
let appArchives = 0;

const addArchive = (full) => {
  archives++;
  if (path.basename(full) === 'app.asar') appArchives++;
  for (const inner of asar.listPackage(full, { isPack: false })) {
    const rel = inner.replace(/^[\\/]+/, '');
    let stat;
    try {
      stat = asar.statFile(full, rel);
    } catch {
      entries.push({ path: `${full}!/${rel}`, read: () => null });
      continue;
    }
    if (stat.files) continue;
    entries.push({
      path: `${full}!/${rel}`,
      ...(typeof stat.size === 'number' ? { size: stat.size } : {}),
      read: () => { try { return asar.extractFile(full, rel); } catch { return null; } },
    });
  }
};

const walk = (dir) => {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    let real;
    let stat;
    try {
      real = fs.realpathSync(full);
      stat = fs.statSync(full);
    } catch {
      // A link to nothing: what it was meant to ship cannot be checked.
      entries.push({ path: full, read: () => null });
      continue;
    }
    // A link out of the package ships the link, not its target.
    if (item.isSymbolicLink() && !insideRoot(real)) continue;
    if (visited.has(real)) {
      // The target was read already, but a link's own path can still be a
      // fake agent's place (a `fake-agents/x` link to a clean file).
      if (item.isSymbolicLink() && pathNamesFakeAgent(full, index)) {
        entries.push(stat.isFile()
          ? { path: full, size: stat.size, read: () => { try { return fs.readFileSync(full); } catch { return null; } } }
          : { path: full, read: () => null });
      }
      continue;
    }
    visited.add(real);
    if (stat.isDirectory()) walk(full);
    else if (item.name.endsWith('.asar')) addArchive(full);
    else if (stat.isFile()) entries.push({ path: full, size: stat.size, read: () => { try { return fs.readFileSync(full); } catch { return null; } } });
  }
};
visited.add(rootReal);
walk(root);

if (appArchives === 0) {
  console.error(`release bundle check: no app.asar under ${root}; package the app first`);
  process.exit(2);
}
const { found, unreadable } = shippedFakeAgents(entries, index);
if (found.length > 0 || unreadable.length > 0) {
  if (found.length > 0) {
    console.error(`release bundle check: FAIL: ${found.length} e2e fake agent file(s) in the package:`);
    for (const p of found) console.error(`  ${p}`);
  }
  if (unreadable.length > 0) {
    console.error(`release bundle check: FAIL: ${unreadable.length} file(s) that could not be read to check:`);
    for (const p of unreadable) console.error(`  ${p}`);
  }
  process.exit(1);
}
console.log(`release bundle check: ok (${entries.length} files in ${archives} archive(s) and around them, no fake agent)`);
