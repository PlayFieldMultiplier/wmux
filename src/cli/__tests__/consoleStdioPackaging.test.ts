import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// consoleStdio.ts requires koffi at runtime. The packaged CLI finds it only if
// the bundle leaves it external (esbuild would otherwise inline koffi's loader,
// which finds its native binary relative to its own package) and forge ships
// it beside the bundle. Without it the CLI quietly keeps garbled or lost
// output, so both are pinned over their source, as the other packaging
// invariants are (makerDebAsarCache.test.ts).
const repo = path.join(__dirname, '..', '..', '..');

describe('koffi ships with the CLI bundle', () => {
  it('build:cli leaves koffi external', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:cli']).toMatch(/esbuild dist\/cli\/cli\/index\.js [^&]*--external:koffi/);
  });

  it('postPackage copies koffi into cli-bundle/node_modules, and fails without the bundle', () => {
    const src = fs.readFileSync(path.join(repo, 'forge.config.ts'), 'utf8');
    expect(src).toMatch(/const cliBundleDir = path\.join\(resourcesDir, 'cli-bundle'\);/);
    expect(src).toMatch(/copyKoffiInto\(path\.join\(cliBundleDir, 'node_modules'\)\);/);
    expect(src).toMatch(/if \(!fs\.existsSync\(cliBundleDir\)\) \{\s*throw new Error/);
  });
});
