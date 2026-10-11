import { describe, it, expect } from 'vitest';
import { CRITICAL_PATTERNS, hasCriticalRisk, hasCriticalRiskIn, hasElevatedRisk } from '../criticalPatterns';

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
    expect(CRITICAL_PATTERNS.every((p) => !p.regex?.global)).toBe(true);
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
    // 100 KB: one pass over the text; a lookahead from every `del` to the end
    // of the line would take seconds.
    for (const text of ['del '.repeat(25_000), 'rd '.repeat(25_000) + '/q', '('.repeat(100_000)]) {
      const started = Date.now();
      expect(hasCriticalRisk(text)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('finds -Recurse however far past the verb it is: a long path does not hide it', () => {
    const paths = Array.from({ length: 4 }, (_, i) => `'C:\\Users\\me\\AppData\\Local\\Temp\\build-cache-${i}\\${'x'.repeat(50)}'`);
    const cmd = `Remove-Item -Path ${paths.join(',')} -Recurse -Force`;
    expect(cmd.indexOf('-Recurse')).toBeGreaterThan(260);
    expect(hasCriticalRisk(cmd)).toBe(true);
  });

  it('accepts the en dash, em dash and horizontal bar PowerShell takes as parameter prefixes', () => {
    for (const dash of ['\u2013', '\u2014', '\u2015']) {
      expect(hasCriticalRisk(`Remove-Item ${dash}Recurse C:\\x`), dash).toBe(true);
      expect(hasCriticalRisk(`rm ${dash}r ${dash}fo C:\\x`), dash).toBe(true);
    }
  });

  it("flags cmd's switch glued to the verb", () => {
    for (const cmd of ['cmd /c rd/s/q build', 'rd/s build', 'del/s/q *.bak', 'RMDIR/Q/S x']) {
      expect(hasCriticalRisk(cmd), cmd).toBe(true);
    }
  });

  it('reads the command line of cmd /c and powershell -Command, quoted or not', () => {
    for (const cmd of [
      'cmd /c "rd /s /q build"',
      'cmd.exe /C "if exist build rd /s /q build"',
      'powershell -Command "Remove-Item .\\dist -Recurse -Force"',
      "pwsh -c 'ri .\\tmp -r'",
      // Inside PowerShell, `rm -r` is Remove-Item -Recurse.
      'powershell -NoProfile -Command "rm -r .\\dist"',
    ]) {
      expect(hasCriticalRisk(cmd), cmd).toBe(true);
    }
    expect(hasCriticalRisk('cmd /c "dir /s"')).toBe(false);
  });

  it('finds the delete inside brackets, but not a -Recurse that belongs to a nested command', () => {
    expect(hasCriticalRisk('Get-ChildItem | ForEach-Object { ri $_.FullName -r }')).toBe(true);
    expect(hasCriticalRisk('Remove-Item (Join-Path $root dist) -Recurse')).toBe(true);
    expect(hasCriticalRisk('Remove-Item (Get-ChildItem -Recurse -Filter *.tmp)')).toBe(false);
  });

  it('is not fooled by a separator inside quotes', () => {
    expect(hasCriticalRisk("Remove-Item 'a;b' -Recurse")).toBe(true);
    expect(hasCriticalRisk("Write-Output 'del x; ri y -r'")).toBe(false);
  });

  it('only flags a PowerShell delete in command position, so prose is not a tree delete', () => {
    for (const line of [
      'Uso del comando: grep -r foo .',
      'Elimina las entradas del cache con rsync -r --delete',
      'Run rd later; make -r is fine',
      'Please remove-item this from the list -r',
    ]) {
      expect(hasCriticalRisk(line), line).toBe(false);
    }
  });

  it('treats `rm -r` as a tree delete when the caller knows the text is PowerShell', () => {
    expect(hasCriticalRiskIn('powershell', 'rm -r .\\src')).toBe(true);
    expect(hasCriticalRiskIn('powershell', 'rm .\\a.txt')).toBe(false);
    expect(hasCriticalRiskIn('any', 'rm -r .\\src')).toBe(false);
    expect(hasCriticalRisk('rm -r .\\src')).toBe(false);
  });
});
