// What counts as a docs-only change for a verify worker's lighter reading.
import { describe, expect, it } from 'vitest';
import { isDocsPath } from '../docsChange';

describe('isDocsPath', () => {
  it('text and images anywhere; .txt and markup only in a docs folder; LICENSE and NOTICE by name', () => {
    for (const p of ['README.md', 'CHANGELOG.MD', 'src/guide.rst', 'assets/logo.png', 'docs/a.txt', 'docs/guide.html', 'doc/x.svg', 'Docs/site.css', 'docs/a/b/index.htm', 'LICENSE', 'LICENSE.txt', 'pkg/NOTICE', 'NOTICE.md', 'LICENSE-MIT']) {
      expect(isDocsPath(p), p).toBe(true);
    }
  });

  it('code, build and dependency lists, compiled markup and app pages are not docs', () => {
    for (const p of [
      'src/app.py', 'docs/conf.py', 'docs/x.test.ts', 'docs/page.mdx', 'page.mdx', 'CMakeLists.txt', 'requirements.txt', 'requirements-dev.txt',
      'tests/fixtures/input.txt', 'index.html', 'src/daemon/web/frontend/index.html', 'icon.svg', 'docs/Makefile', 'Makefile',
      '.github/workflows/ci.yml', 'package.json', 'docs/.md', 'licenses.py', 'LICENSE.js', 'tools/notice.py', '', '../x.md', '/abs/a.md', 'a//b.md',
    ]) {
      expect(isDocsPath(p), p).toBe(false);
    }
  });
});
