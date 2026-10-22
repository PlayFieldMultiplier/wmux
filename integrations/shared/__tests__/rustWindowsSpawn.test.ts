import { describe, expect, it } from 'vitest';
import { rustWindowsQuoteArg } from './rustWindowsSpawn';

// The port is only as good as its fidelity to Rust std. These are the argument
// cases of Rust's own `test_make_command_line`
// (library/std/src/sys/process/windows/tests.rs, force_quotes = false), so a
// drift from the real algorithm fails here rather than in the spawn replay.
describe('rustWindowsQuoteArg', () => {
  // Plain strings, every backslash escaped: a raw template cannot end in one.
  it.each([
    ['aaa', 'aaa'],
    ['C:\\', 'C:\\'],
    ['2slashes\\\\', '2slashes\\\\'],
    [' C:\\', '" C:\\\\"'],
    [' 2slashes\\\\', '" 2slashes\\\\\\\\"'],
    ['v*', 'v*'],
    ['aa"bb', 'aa\\"bb'],
    ['a b c', '"a b c"'],
    ['" \\" \\', '"\\" \\\\\\" \\\\"'],
    ['\\', '\\'],
  ])('%s -> %s', (arg, quoted) => {
    expect(rustWindowsQuoteArg(arg)).toBe(quoted);
  });

  it('quotes an empty argument so it is not dropped', () => {
    expect(rustWindowsQuoteArg('')).toBe('""');
  });
});
