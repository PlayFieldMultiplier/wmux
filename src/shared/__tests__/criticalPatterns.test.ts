import { describe, it, expect } from 'vitest';
import { CRITICAL_PATTERNS, hasCriticalRisk, hasElevatedRisk } from '../criticalPatterns';

describe('hasCriticalRisk', () => {
  it('matches the destructive actions the PTY scanner already knows', () => {
    expect(hasCriticalRisk('sudo rm -rf /var/tmp/build')).toBe(true);
    expect(hasCriticalRisk('git push --force origin main')).toBe(true);
    expect(hasCriticalRisk('DROP TABLE sessions;')).toBe(true);
    expect(hasCriticalRisk('terraform destroy -auto-approve')).toBe(true);
  });

  it('scans every argument, so a danger can live in an option label', () => {
    expect(hasCriticalRisk('How should I clean up?', 'Leave it', 'rm -rf node_modules/')).toBe(true);
  });

  it('ignores the softer review tier — this answers one yes/no question', () => {
    // `kubectl delete` and `DELETE FROM` are riskLevel 'review', not 'critical'.
    expect(hasCriticalRisk('kubectl delete pod web-1')).toBe(false);
    expect(hasCriticalRisk('DELETE FROM users WHERE id = 1')).toBe(false);
  });

  it('is quiet on ordinary text and on nothing at all', () => {
    expect(hasCriticalRisk('Which approach should I take?')).toBe(false);
    expect(hasCriticalRisk(undefined, null, '')).toBe(false);
  });

  it('carries no `g` flag, so repeated calls cannot desync on lastIndex', () => {
    expect(CRITICAL_PATTERNS.every((p) => !p.regex.global)).toBe(true);
    expect(hasCriticalRisk('npm publish')).toBe(true);
    expect(hasCriticalRisk('npm publish')).toBe(true);
  });
});

describe('hasElevatedRisk — the lock-screen question', () => {
  it('counts the review tier, which hasCriticalRisk deliberately does not', () => {
    for (const text of ['DELETE FROM users', 'kubectl delete pod api-7']) {
      expect(hasCriticalRisk(text)).toBe(false);
      expect(hasElevatedRisk(text)).toBe(true);
    }
  });

  it('still counts the critical tier', () => {
    expect(hasElevatedRisk('rm -rf ./build')).toBe(true);
    expect(hasElevatedRisk('terraform destroy')).toBe(true);
  });

  it('says no to ordinary text, and to nothing at all', () => {
    expect(hasElevatedRisk('write src/a.ts')).toBe(false);
    expect(hasElevatedRisk(undefined, null, '')).toBe(false);
  });

  it('scans every argument, not only the first', () => {
    expect(hasElevatedRisk('Proceed?', 'yes', 'DROP TABLE users')).toBe(true);
  });
});

describe('Windows tree deletes (#1939)', () => {
  it('flags Remove-Item -Recurse, in full, abbreviated, or by alias, with or without -Force', () => {
    for (const cmd of [
      'Remove-Item -Recurse -Force C:\\work\\build',
      'Remove-Item -Path .\\dist -Force -Recurse',
      'Remove-Item -Recurse .\\build',
      'remove-item .\\out -recurse',
      'ri -r .\\tmp',
      'rmdir build -Recurse',
      'rd -re .\\cache',
      'del -Recurse .\\logs',
      'erase -Recurse -Force .\\logs',
      'Remove-Item -Recurse:$true .\\x',
      'Get-ChildItem .\\a | Remove-Item -Recurse -Force',
      'if (Test-Path x) { Remove-Item x -Recurse -Force }',
      'Remove-Item .\\big `\n  -Recurse `\n  -Force',
      // `rm` needs a PowerShell -Force too.
      'rm -r -fo node_modules',
      'rm -Recurse -Force .\\dist',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(true);
    }
  });

  it("flags cmd's rd /s and del /s, wherever the switch sits, in any case", () => {
    for (const cmd of [
      'cmd /c rd /s /q build',
      'cmd /c rd /q /s build',
      'RMDIR /S/Q C:\\x',
      'rmdir build /s /q',
      'del /s /q *.*',
      'erase /q /s *.tmp',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(true);
    }
  });

  it('leaves non-recursive deletes and lookalikes alone', () => {
    for (const cmd of [
      'Remove-Item -Force .\\a.txt',
      'Get-ChildItem -Recurse -Force',
      // `rm -r` without -f stays unflagged, as on Unix.
      'rm -r build',
      'rm -r .\\build',
      // The flag belongs to another statement or pipeline segment.
      'Remove-Item a.txt; Get-ChildItem -Recurse -Force',
      'rm .\\a.txt && Get-ChildItem -Recurse -Force',
      'Get-ChildItem -Recurse -Force | Select-Object Name',
      // The verb is part of another word or flag.
      'Remove-ItemProperty -Path HKCU:\\x -Name y -Recurse',
      'docker run --rm -it image -r -format json',
      'Set-Content -Path a.txt -Value key-test',
      // A `/s` glued to a word is not a switch.
      'la velocidad del cohete es 3 km/s',
      'rd C:\\tools /q',
      'del /q a.txt',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(false);
    }
  });

  it('stays linear on a long line full of verb-like words', () => {
    // 100 KB: a few ms with the capped segment; an uncapped lookahead rescans
    // to the end of the line from every `del` and takes seconds.
    const text = 'del '.repeat(25_000);
    const started = Date.now();
    expect(hasCriticalRisk(text)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
