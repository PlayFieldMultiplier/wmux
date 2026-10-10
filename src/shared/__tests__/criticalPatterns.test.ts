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
  it('flags Remove-Item with -Recurse and -Force, in full, abbreviated, or by alias', () => {
    for (const cmd of [
      'Remove-Item -Recurse -Force C:\\work\\build',
      'Remove-Item -Path .\\dist -Force -Recurse',
      'remove-item .\\out -recurse -force',
      'rm -r -fo node_modules',
      'ri -Recurse -Force .\\tmp',
      'rmdir build -Recurse -Force',
      'rd -r -force .\\cache',
      'del -Recurse -Force .\\logs',
      'erase -Recurse -Force .\\logs',
      'Remove-Item -Recurse:$true -Force .\\x',
      'Get-ChildItem .\\a | Remove-Item -Recurse -Force',
      'Remove-Item .\\big `\n  -Recurse `\n  -Force',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(true);
    }
  });

  it("flags cmd's rd /s like rmdir /S, in any case", () => {
    expect(hasCriticalRisk('cmd /c rd /s /q build')).toBe(true);
    expect(hasCriticalRisk('RMDIR /S /Q build')).toBe(true);
  });

  it('leaves non-destructive or non-forced PowerShell alone', () => {
    for (const cmd of [
      // -Recurse alone is not flagged, the same way `rm -r` is not.
      'Remove-Item -Recurse .\\build',
      'Remove-Item -Force .\\a.txt',
      'Get-ChildItem -Recurse -Force',
      // The flags belong to another statement or pipeline segment.
      'Remove-Item a.txt; Get-ChildItem -Recurse -Force',
      'Get-ChildItem -Recurse -Force | Select-Object Name',
      // The verb is part of another word or flag.
      'Remove-ItemProperty -Path HKCU:\\x -Name y -Recurse -Force',
      'docker run --rm -it -e RUN=1 image -r -format json',
      'Set-Content -Path a.txt -Value key-test',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(false);
    }
  });
});
