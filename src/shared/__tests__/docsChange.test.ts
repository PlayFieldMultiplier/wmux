// What counts as a docs-only change: the one definition the reviewer's
// prompt, main's reading-only verdict and the merge lane share.
import { describe, expect, it } from 'vitest';
import { isDocsOnlyChange, isDocsPath } from '../docsChange';

describe('isDocsPath', () => {
  it('text and images anywhere; markup only in a docs folder', () => {
    for (const p of ['README.md', 'CHANGELOG.MD', 'notes/a.txt', 'src/guide.rst', 'assets/logo.png', 'docs/guide.html', 'doc/x.svg', 'Docs/site.css', 'docs/a/b/index.htm']) {
      expect(isDocsPath(p), p).toBe(true);
    }
  });

  it('code is not docs, in a docs folder or not; app markup outside docs is code', () => {
    for (const p of ['src/app.py', 'docs/conf.py', 'docs/x.test.ts', 'index.html', 'src/daemon/web/frontend/index.html', 'icon.svg', 'docs/Makefile', 'Makefile', '.github/workflows/ci.yml', 'package.json', 'docs/.md', '', '../x.md', '/abs/a.md', 'a//b.md']) {
      expect(isDocsPath(p), p).toBe(false);
    }
  });
});

describe('isDocsOnlyChange', () => {
  it('a complete, non-empty list of docs paths', () => {
    expect(isDocsOnlyChange(['README.md', 'docs/guide.html'], false)).toBe(true);
    expect(isDocsOnlyChange(['README.md', 'src/a.ts'], false)).toBe(false);
    expect(isDocsOnlyChange(['README.md'], true)).toBe(false);
    expect(isDocsOnlyChange([], false)).toBe(false);
  });
});
