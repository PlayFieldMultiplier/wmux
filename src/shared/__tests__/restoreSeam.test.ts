import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { restoreSeam } from '../restoreSeam';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const viewportText = (term: Terminal): string[] => {
  const b = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  }
  return rows;
};

describe('restoreSeam', () => {
  it('scrolls the restored screen into scrollback and homes the cursor', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 30; i++) await write(term, `history line ${i}\r\n`);
    await write(term, 'PS C:\\> '); // dead prompt, no trailing newline

    await write(term, restoreSeam(term.rows));

    const b = term.buffer.active;
    // Cursor is home on an empty viewport…
    expect(b.cursorX).toBe(0);
    expect(b.cursorY).toBe(0);
    expect(viewportText(term).every((row) => row === '')).toBe(true);
    // …and every restored row survives in scrollback.
    const scrollback: string[] = [];
    for (let y = 0; y < b.baseY; y++) {
      scrollback.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    expect(scrollback.join('\n')).toContain('history line 1');
    expect(scrollback.join('\n')).toContain('history line 30');
    expect(scrollback.join('\n')).toContain('PS C:\\>');
  });

  it("aligns a fresh process's absolute repaints with its appended plain text", async () => {
    // The #952 failure shape: after restore, plain-text output appended at the
    // cursor and absolute-CUP repaints (PSReadLine) disagreed about where the
    // prompt is. After the seam both land on viewport row 1.
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 30; i++) await write(term, `history line ${i}\r\n`);

    await write(term, restoreSeam(term.rows));
    await write(term, 'PS C:\\> ');            // fresh prompt, plain text
    await write(term, '\x1b[1;9Hqweqwewqe');   // PSReadLine-style absolute repaint

    const b = term.buffer.active;
    const promptRow = b.getLine(b.baseY)?.translateToString(true) ?? '';
    expect(promptRow).toBe('PS C:\\> qweqwewqe');
    // No restored row was overdrawn (trailing scrollback rows are the old
    // viewport's blank tail; the content sits just above them).
    const tail: string[] = [];
    for (let y = Math.max(0, b.baseY - term.rows); y < b.baseY; y++) {
      tail.push(b.getLine(y)?.translateToString(true) ?? '');
    }
    expect(tail.join('\n')).toContain('history line 30');
  });

  it('exits the alternate screen in case the dump ended inside one', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    await write(term, 'normal content\r\n');
    await write(term, '\x1b[?1049h'); // dump ended mid-vim
    expect(term.buffer.active.type).toBe('alternate');

    await write(term, restoreSeam(term.rows));
    expect(term.buffer.active.type).toBe('normal');
  });

  it('leaves the alternate screen however the dead program entered it, so the next program starts on a fresh one', async () => {
    // Claude Code 2.1 runs in the alternate screen. A recovered pane restores
    // the dead instance's frame, then `claude --resume` enters the alternate
    // screen again and diff-renders. Nothing of the dead frame may survive.
    for (const entry of ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h']) {
      const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
      await write(term, 'normal content\r\n' + entry);
      for (let i = 1; i <= 24; i++) await write(term, `\x1b[${i};1Hstale frame row ${i}`);

      await write(term, restoreSeam(term.rows));
      expect(term.buffer.active.type).toBe('normal');

      await write(term, 'PS C:\\> claude --resume x\r\n');
      await write(term, '\x1b[?1049h\x1b[22;1Hstatus line'); // a partial first frame, no erase
      expect(term.buffer.active.type).toBe('alternate');
      const rows = viewportText(term);
      expect(rows.filter((row) => row.includes('stale frame'))).toEqual([]);
      expect(rows[21]).toBe('status line');
    }
  });

  it('releases a scroll region the dead program left, so every restored row reaches scrollback', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (let i = 1; i <= 24; i++) await write(term, `\x1b[${i};1Hstale row ${i}`);
    await write(term, '\x1b[1;10r\x1b[?6h'); // DECSTBM + DECOM, never released

    await write(term, restoreSeam(term.rows));

    expect(viewportText(term).every((row) => row === '')).toBe(true);
    const b = term.buffer.active;
    expect(b.cursorX).toBe(0);
    expect(b.cursorY).toBe(0);
    const scrollback: string[] = [];
    for (let y = 0; y < b.baseY; y++) scrollback.push(b.getLine(y)?.translateToString(true) ?? '');
    expect(scrollback.join('\n')).toContain('stale row 1');
    expect(scrollback.join('\n')).toContain('stale row 24');
    expect(term.modes.originMode).toBe(false);
  });

  it('returns the input and cursor modes the dead program armed to their power-on values', async () => {
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true });
    await write(term, '\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h');

    await write(term, restoreSeam(term.rows));

    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(term.modes.sendFocusMode).toBe(false);
    expect(term.modes.bracketedPasteMode).toBe(false);
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    expect(term.modes.wraparoundMode).toBe(true);
    expect(term.modes.showCursor).toBe(true);
  });

  it('clamps hostile row counts', () => {
    expect(restoreSeam(0)).toBe(restoreSeam(1));
    expect(restoreSeam(-5)).toBe(restoreSeam(1));
    expect(restoreSeam(Number.NaN)).toBe(restoreSeam(1));
    // 512 line feeds at most, plus the fixed mode resets.
    expect(restoreSeam(1e9).length).toBeLessThan(700);
  });
});
