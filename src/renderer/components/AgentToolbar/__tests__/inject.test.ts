import { describe, it, expect } from 'vitest';
import { quotePathsForPrompt, buildSubmitWrites } from '../inject';

describe('quotePathsForPrompt', () => {
  it('single-quotes paths with spaces on POSIX and joins with a single space', () => {
    expect(quotePathsForPrompt(['/a/b.png', '/c d/e.ts'], 'darwin')).toBe("/a/b.png '/c d/e.ts'");
  });
  it('returns empty string for no paths', () => {
    expect(quotePathsForPrompt([], 'darwin')).toBe('');
  });
  it('single-quotes shell metacharacters on POSIX', () => {
    for (const name of ['$(echo X)', '`id`', 'a;b', 'a&b', 'a|b', '*', '!x', 'a"b']) {
      expect(quotePathsForPrompt([`/r/${name}`], 'linux')).toBe(`'/r/${name}'`);
    }
  });
  it("escapes an embedded single quote as '\\'' on POSIX", () => {
    expect(quotePathsForPrompt(["/r/it's"], 'darwin')).toBe("'/r/it'\\''s'");
  });
  it('leaves out paths with control characters and keeps the rest', () => {
    for (const c of ['\n', '\r', '\t', '\x1b', '\x00', '\x7f', '\x85', '\x9b']) {
      expect(quotePathsForPrompt([`/r/a${c}b`], 'darwin')).toBe('');
      expect(quotePathsForPrompt(['/ok', `/r/a${c}b`, '/ok2'], 'win32', 'pwsh.exe')).toBe('/ok /ok2');
    }
  });
  it('uses PowerShell single quotes on Windows by default', () => {
    expect(quotePathsForPrompt(['C:\\a\\b.txt'], 'win32', 'powershell')).toBe('C:\\a\\b.txt');
    expect(quotePathsForPrompt(['C:\\a b\\$x.txt'], 'win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
      .toBe("'C:\\a b\\$x.txt'");
    expect(quotePathsForPrompt(['C:\\a,b.txt'], 'win32', undefined)).toBe("'C:\\a,b.txt'");
    expect(quotePathsForPrompt(["C:\\it's\u2019.txt"], 'win32', 'powershell')).toBe("'C:\\it''s\u2019\u2019.txt'");
  });
  it('keeps the double-quote-on-space rule for cmd.exe', () => {
    expect(quotePathsForPrompt(['C:\\a b\\c.txt', 'C:\\d.txt'], 'win32', 'C:\\Windows\\System32\\cmd.exe'))
      .toBe('"C:\\a b\\c.txt" C:\\d.txt');
    expect(quotePathsForPrompt(['C:\\a b'], 'win32', 'cmd')).toBe('"C:\\a b"');
  });
  it('uses POSIX quoting for a Git Bash or WSL default shell on Windows', () => {
    expect(quotePathsForPrompt(["C:\\it's"], 'win32', 'gitbash')).toBe("'C:\\it'\\''s'");
    expect(quotePathsForPrompt(['C:\\a b'], 'win32', 'C:\\Windows\\System32\\wsl.exe')).toBe("'C:\\a b'");
  });
});

describe('buildSubmitWrites', () => {
  it('returns the text then a lone CR when submit=true', () => {
    expect(buildSubmitWrites('hello', true)).toEqual(['hello', '\r']);
  });
  it('returns just the text when submit=false', () => {
    expect(buildSubmitWrites('hello', false)).toEqual(['hello']);
  });
});
