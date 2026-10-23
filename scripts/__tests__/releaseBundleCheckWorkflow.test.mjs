// The release workflow checks every package it makes for the e2e fake agents
// (scripts/check-release-bundle.mjs), and nothing it uploads skips that check.
// The workflow only runs for real on a tag, so this pins the steps by text.
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

/** Each job's steps, as the text from one `      - ` to the next. */
function jobs() {
  const out = [];
  for (const job of RELEASE.split(/\n(?=  [a-z][\w-]*:\n)/).slice(1)) {
    const steps = job.split(/\n(?= {6}- )/).slice(1);
    out.push({ name: job.slice(2, job.indexOf(':')), steps });
  }
  return out;
}

const isMake = (s) => /\n {8}run: npm run make\n/.test(`${s}\n`);
const isCheck = (s) => s.includes('run: node scripts/check-release-bundle.mjs out');
const isUpload = (s) => /uses: (actions\/upload-artifact|softprops\/action-gh-release)|gh release upload/.test(s);
const ifOf = (s) => /\n {8}if: (.*)/.exec(s)?.[1] ?? '';

describe('release.yml bundle check', () => {
  const withMake = jobs().filter((j) => j.steps.some(isMake));

  it('runs after each of the three make steps, on what any make left, and keeps no cap of its own', () => {
    expect(withMake.map((j) => j.name)).toEqual(['build', 'macos', 'linux']);
    for (const { steps } of withMake) {
      const make = steps.findIndex(isMake);
      const check = steps.findIndex(isCheck);
      expect(check).toBe(make + 1);
      expect(ifOf(steps[check])).toBe('always()');
      expect(steps[check]).toContain('id: bundle-check');
      expect(steps[check]).not.toContain('timeout-minutes');
    }
  });

  it('leaves the make steps their own time caps (macOS 60, Linux 30)', () => {
    const cap = (name) => /timeout-minutes: (\d+)/.exec(withMake.find((j) => j.name === name).steps.find(isMake))?.[1];
    expect(cap('macos')).toBe('60');
    expect(cap('linux')).toBe('30');
  });

  it('gates every upload after it: an always() upload waits on its outcome, the rest on success', () => {
    let uploads = 0;
    for (const { steps } of withMake) {
      const check = steps.findIndex(isCheck);
      for (const s of steps.slice(check + 1).filter(isUpload)) {
        uploads++;
        const cond = ifOf(s);
        if (cond.includes('always()')) expect(cond).toContain("steps.bundle-check.outcome == 'success'");
        else expect(cond).not.toMatch(/failure\(\)|cancelled\(\)/);
      }
    }
    expect(uploads).toBeGreaterThanOrEqual(6);
  });
});
