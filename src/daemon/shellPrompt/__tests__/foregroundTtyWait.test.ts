import { describe, expect, it } from 'vitest';
import { classifyWaitChannel, foregroundGroupFromStat, foregroundTtyWait } from '../foregroundTtyWait';

describe('foregroundTtyWait', () => {
  it('reads the foreground group from /proc stat, past a comm with spaces and parentheses', () => {
    expect(foregroundGroupFromStat('412 (my (odd) sh) S 400 412 412 34817 4321 4194560 0 0')).toBe(4321);
    expect(foregroundGroupFromStat('412 (sh) S 400 412 412 0 -1 0')).toBeNull();
    expect(foregroundGroupFromStat('garbage')).toBeNull();
  });

  it('names a tty read, a non-input wait, and what cannot tell', () => {
    expect(classifyWaitChannel('n_tty_read')).toBe('reads');
    expect(classifyWaitChannel('wait_woken\n')).toBe('reads');
    expect(classifyWaitChannel('do_wait')).toBe('other');
    expect(classifyWaitChannel('hrtimer_nanosleep')).toBe('other');
    expect(classifyWaitChannel('ep_poll')).toBe('unknown');
    expect(classifyWaitChannel('0')).toBe('unknown');
    expect(classifyWaitChannel(null)).toBe('unknown');
  });

  it('follows the shell to its foreground group leader; unknown when anything cannot be read', () => {
    const files: Record<string, string> = {
      '/proc/412/stat': '412 (bash) S 400 412 412 34817 4321 0',
      '/proc/4321/wchan': 'n_tty_read',
    };
    const read = (file: string) => files[file] ?? null;
    expect(foregroundTtyWait(412, 'linux', read)).toBe('reads');
    files['/proc/4321/wchan'] = 'do_wait';
    expect(foregroundTtyWait(412, 'linux', read)).toBe('other');
    delete files['/proc/4321/wchan'];
    expect(foregroundTtyWait(412, 'linux', read)).toBe('unknown');
    // The shell itself in the foreground, or no stat at all.
    files['/proc/412/stat'] = '412 (bash) S 400 412 412 34817 412 0';
    expect(foregroundTtyWait(412, 'linux', read)).toBe('unknown');
    expect(foregroundTtyWait(999, 'linux', read)).toBe('unknown');
  });

  it('is unknown off Linux: macOS has no wait channel to read, and it never vetoes there', () => {
    expect(foregroundTtyWait(412, 'darwin', () => 'do_wait')).toBe('unknown');
  });
});
