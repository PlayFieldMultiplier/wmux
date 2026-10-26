// scripts/lib/vitest-hashbang-lf.mjs: a JavaScript file whose hashbang line
// ends in CRLF loads under Vitest, and every vitest config carries the plugin.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HASHBANG_LF_PLUGIN, hashbangToLf } from '../lib/vitest-hashbang-lf.mjs';
import { ROOT } from '../lib/test-lanes.mjs';

describe('a CRLF hashbang file under Vitest', () => {
  // Inside the repo, so Vite transforms it like any other module. The CRLF is
  // in the file's bytes, so this fails without the plugin on any checkout.
  const dir = fs.mkdtempSync(path.join(ROOT, 'scripts', '__tests__', '.hashbang-lf-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads, with its imports below the hashbang', async () => {
    const file = path.join(dir, 'crlf-script.mjs');
    fs.writeFileSync(file, "#!/usr/bin/env node\r\nimport path from 'node:path';\r\nexport const sep = path.sep;\r\n");
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
    expect(mod.sep).toBe(path.sep);
  });
});

describe('hashbangToLf', () => {
  it('ends a CRLF hashbang line in LF and moves nothing else', () => {
    expect(hashbangToLf('#!/usr/bin/env node\r\nconst a = 1;\r\n', '/x/a.mjs')).toBe('#!/usr/bin/env node\nconst a = 1;\r\n');
    expect(hashbangToLf('#!/usr/bin/env node\r\n', '/x/a.cjs?v=1')).toBe('#!/usr/bin/env node\n');
    expect(hashbangToLf('#!node\r\nx', '/x/a.js')).toBe('#!node\nx');
  });

  it('leaves an LF hashbang, a file with none, and TypeScript alone', () => {
    expect(hashbangToLf('#!/usr/bin/env node\nconst a = 1;\r\n', '/x/a.mjs')).toBeNull();
    expect(hashbangToLf('const a = 1;\r\n#!x\r\n', '/x/a.mjs')).toBeNull();
    expect(hashbangToLf('#!/usr/bin/env node\r\n', '/x/a.ts')).toBeNull();
  });
});

describe('every vitest config', () => {
  it('registers the plugin', async () => {
    const configs = fs.readdirSync(ROOT).filter((name) => /^vitest\b.*\.config\.[cm]?[jt]s$/.test(name));
    expect(configs.length).toBeGreaterThanOrEqual(5);
    for (const name of configs) {
      const config = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, name)).href)).default;
      const plugins = (config.plugins ?? []).flat();
      expect(plugins.map((p) => p?.name), name).toContain(HASHBANG_LF_PLUGIN);
      // A project inherits the root's plugins only with `extends: true`.
      for (const project of config.test?.projects ?? []) expect(project.extends, `${name} project`).toBe(true);
    }
  });
});
