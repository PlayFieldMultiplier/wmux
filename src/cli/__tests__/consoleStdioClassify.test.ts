import { describe, it, expect } from 'vitest';
import { classifyStdHandle } from '../consoleStdio';

describe('classifyStdHandle', () => {
  const never = () => { throw new Error('a handle that is not there has no device to read'); };

  it('reads NULL, zero and INVALID_HANDLE_VALUE as no handle, without querying them', () => {
    expect(classifyStdHandle(null, never)).toBe('none');
    expect(classifyStdHandle(0n, never)).toBe('none');
    expect(classifyStdHandle(0xffffffffffffffffn, never)).toBe('none');
  });

  it('tells the console from a file, a pipe, NUL or an unreadable handle', () => {
    expect(classifyStdHandle(0x1a4n, () => 0x50)).toBe('console');
    for (const device of [0x07, 0x11, 0x15, null]) expect(classifyStdHandle(0x1a4n, () => device)).toBe('other');
  });
});
