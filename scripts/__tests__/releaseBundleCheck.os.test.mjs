// The release bundle check end to end, on a small package built here: a real
// .asar, real symlinks, the real fixtures.
// @wmux-lane integration
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-release-bundle.mjs');
const asar = createRequire(import.meta.url)('@electron/asar');
const fixture = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'fixtures', 'fake-agents', 'claude.mjs'));

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** An output dir holding app.asar packed from `files` (relative path to contents). */
async function packaged(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bundle-check-'));
  dirs.push(base);
  const src = path.join(base, 'src');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  const out = path.join(base, 'out');
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  await asar.createPackage(src, path.join(out, 'resources', 'app.asar'));
  return out;
}

const check = (out) => spawnSync(process.execPath, [SCRIPT, out], { encoding: 'utf8' });

// Creating symlinks on Windows needs a privilege the runner may not hold.
describe.skipIf(process.platform === 'win32')('check-release-bundle.mjs', () => {
  it('passes a clean package with directories in its archive and a symlink cycle beside it', async () => {
    const out = await packaged({ '.vite/build/index.js': 'app', 'node_modules/x/claude.mjs': 'a real module' });
    fs.symlinkSync('..', path.join(out, 'resources', 'loop'));
    fs.symlinkSync('resources', path.join(out, 'Current'));
    const run = check(out);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('fails on a fixture renamed inside the archive', async () => {
    const out = await packaged({ '.vite/build/index.js': 'app', '.vite/build/chunk-1.js': fixture });
    const run = check(out);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('app.asar!/.vite/build/chunk-1.js');
  });

  it('follows a symlinked archive and fails on what it holds', async () => {
    const out = await packaged({ 'index.js': 'app' });
    const inner = path.join(path.dirname(out), 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'tool.js'), fixture);
    fs.mkdirSync(path.join(out, 'vendor'));
    await asar.createPackage(inner, path.join(out, 'vendor', 'tools.asar'));
    fs.symlinkSync(path.join('..', 'vendor', 'tools.asar'), path.join(out, 'resources', 'tools.asar'));
    fs.unlinkSync(path.join(out, 'resources', 'app.asar'));
    const run = check(out);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('tools.asar!/tool.js');
  });

  it('fails on a symlink whose target cannot be read', async () => {
    const out = await packaged({ 'index.js': 'app' });
    fs.symlinkSync('missing.js', path.join(out, 'resources', 'dangling.js'));
    const run = check(out);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not be read');
    expect(run.stderr).toContain('dangling.js');
  });
});
