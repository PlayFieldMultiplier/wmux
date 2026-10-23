// The release workflow checks every package it makes for the e2e fake agents
// (scripts/check-release-bundle.mjs) before anything is uploaded. The workflow
// only runs for real on a tag, so this pins the step by text.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

describe('release.yml bundle check', () => {
  it('follows every make step, before the job uploads anything', () => {
    const makes = [...RELEASE.matchAll(/run: npm run make\n/g)].map((m) => m.index);
    expect(makes.length).toBe(3);
    for (const at of makes) {
      const rest = RELEASE.slice(at);
      const check = rest.indexOf('run: node scripts/check-release-bundle.mjs out');
      const upload = rest.search(/uses: (actions\/upload-artifact|softprops\/action-gh-release)/);
      expect(check).toBeGreaterThan(0);
      if (upload >= 0) expect(check).toBeLessThan(upload);
    }
  });
});
