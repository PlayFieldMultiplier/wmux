// The changelog.d fragment checker (scripts/check-changelog-fragments.mjs).
//
// Each fixture folder under fixtures/changelog-check holds one kind of
// mistake that reached, or could reach, the release notes. The checker runs as
// a real process so the exit code and the printed format are what is pinned.
// Assertions go by error codes, not warnings: whether a fixture's PR number
// appears in this checkout's git history is a warning that depends on the
// clone, and must not flip a test.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFragment } from '../lib/changelog-fragments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-changelog-fragments.mjs');
const fixture = (name) => path.join('scripts', '__tests__', 'fixtures', 'changelog-check', name);

function run(...args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status, stdout: err.stdout };
  }
}

function check(name) {
  const result = run('--dir', fixture(name), '--json');
  const report = JSON.parse(result.stdout);
  const codes = (severity) => report.problems.filter((p) => p.severity === severity).map((p) => p.code);
  return { ...result, report, errors: codes('error'), warnings: codes('warning') };
}

describe('scanFragment', () => {
  it('keeps the line each entry starts on and does not throw', () => {
    const scan = scanFragment('### Fixed\n\n- one\n  more\n- two\n\n### Nope\n\n- three\n');
    expect(scan.entries).toEqual({ Fixed: [{ line: 3, text: '- one\n  more' }, { line: 5, text: '- two' }] });
    expect(scan.headings).toEqual([{ line: 1, title: 'Fixed' }, { line: 7, title: 'Nope' }]);
    expect(scan.problems).toEqual([{ line: 7, message: expect.stringContaining('unknown section "Nope"') }]);
  });
});

describe('check-changelog-fragments', () => {
  it('passes a well-formed fragment', () => {
    const { status, errors, warnings } = check('good');
    expect(status).toBe(0);
    expect(errors).toEqual([]);
    expect(warnings.filter((c) => c !== 'pr-unknown')).toEqual([]);
  });

  it('warns about a name that is not a PR number, without failing', () => {
    const { status, errors, warnings } = check('bad-filename');
    expect(status).toBe(0);
    expect(errors).toEqual([]);
    expect(warnings).toContain('filename');
  });

  it('fails an empty fragment', () => {
    const { status, errors } = check('empty');
    expect(status).toBe(1);
    expect(errors).toEqual(['empty-file']);
  });

  it('fails a duplicated entry within a fragment and across fragments, however it is wrapped', () => {
    const { status, report } = check('duplicate');
    expect(status).toBe(1);
    const dups = report.problems.filter((p) => p.code === 'duplicate-entry');
    expect(dups.map((p) => `${path.basename(p.file)}:${p.line}`)).toEqual(['2329.md:5', '2336.md:3']);
    expect(dups[0].message).toContain('line 3');
    expect(dups[1].message).toContain('2329.md:3');
  });

  it('fails "see below" with nothing below it, and accepts "see above" with an entry above or a quoted phrase', () => {
    expect(check('see-below')).toMatchObject({ status: 1, errors: ['see-direction'] });
    expect(check('good').errors).toEqual([]);
  });

  it('fails a section Keep a Changelog does not have', () => {
    const { status, errors } = check('wrong-section');
    expect(status).toBe(1);
    expect(errors).toEqual(['unknown-section']);
  });

  it('fails what the fold would drop or misplace', () => {
    const { report } = check('structure');
    const errors = report.problems.filter((p) => p.severity === 'error').map((p) => [p.line, p.code]);
    expect(errors).toEqual([
      [1, 'text-outside'],
      [5, 'stray-text'],
      [9, 'heading-level'],
      [11, 'empty-section'],
      [13, 'heading-level'],
    ]);
  });

  it('prints file:line: severity: message and a summary without --json', () => {
    const { status, stdout } = run('--dir', fixture('see-below'));
    expect(status).toBe(1);
    const [first, summary] = stdout.trim().split('\n');
    expect(first).toBe(`${fixture('see-below/2329.md')}:3: error: "see below" but no entry is below it in this fragment; the fold reorders fragments, so name what it refers to`);
    expect(summary).toBe('check-changelog-fragments: 1 fragment(s), 1 error(s), 0 warning(s)');
  });

  it('reports counts and problems as JSON', () => {
    const { report } = check('duplicate');
    expect(report).toMatchObject({ files: 2, errors: 2 });
    expect(report.problems[0]).toEqual({
      file: fixture('duplicate/2329.md'),
      line: 5,
      severity: 'error',
      code: 'duplicate-entry',
      message: 'duplicates the entry at line 3',
    });
  });
});
