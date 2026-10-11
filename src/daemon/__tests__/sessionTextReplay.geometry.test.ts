// #1825 on top of #1853: replays are led by the mode preamble, so the recorded
// size-change offsets must move past it to still point at the same ring bytes.
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { readRingTailWithModesAndGeometry, readRingWithModesAndGeometry } from '../sessionTextReplay';

describe('readRingWithModesAndGeometry', () => {
  it('shifts size-change offsets past the preamble', () => {
    const ring = new RingBuffer(1024);
    const tracker = new OutputModeTracker();
    const put = (text: string) => {
      ring.write(Buffer.from(text, 'utf8'));
      tracker.feed(text, ring.totalBytesWritten);
    };
    ring.noteGeometry(80, 24);
    put('\x1b[?1049h');
    put('x'.repeat(2000)); // the alt-screen entry ages out of the 1 KB ring
    ring.noteGeometry(40, 24);
    put('y'.repeat(100));

    const { raw, replay, geometry } = readRingWithModesAndGeometry(ring, tracker);
    const lead = replay.length - raw.length;
    expect(lead).toBeGreaterThan(0);
    expect(geometry?.start).toEqual({ cols: 80, rows: 24 });
    expect(geometry?.changes).toEqual([{ offset: raw.length - 100 + lead, cols: 40, rows: 24 }]);
    expect(replay.subarray(geometry!.changes[0].offset).toString()).toBe('y'.repeat(100));
  });
});

describe('readRingTailWithModesAndGeometry', () => {
  it('cuts forward to a line start, restores earlier modes, and starts at the size in force there', () => {
    const ring = new RingBuffer(64 * 1024);
    const tracker = new OutputModeTracker();
    const put = (text: string) => {
      ring.write(Buffer.from(text, 'utf8'));
      tracker.feed(text, ring.totalBytesWritten);
    };
    ring.noteGeometry(80, 24);
    put('\x1b[?2004h'); // bracketed paste, set long before the tail
    put('a'.repeat(50) + '\n');
    ring.noteGeometry(60, 24);
    put('b'.repeat(500) + '\n');
    ring.noteGeometry(40, 24);
    put('c'.repeat(100) + '\n');

    const tail = readRingTailWithModesAndGeometry(ring, tracker, 300);
    const lead = tail.replay.length - tail.raw.length;
    // 300 bytes back lands inside the b-run; the tail starts at the c line.
    expect(tail.raw.toString()).toBe('c'.repeat(100) + '\n');
    expect(tail.replay.subarray(0, lead).toString()).toContain('\x1b[?2004h');
    // The tail starts exactly where the 40-col mark applies.
    expect(tail.geometry?.start).toEqual({ cols: 40, rows: 24 });
    expect(tail.geometry?.changes).toEqual([]);
  });

  it('keeps later size changes, shifted to the tail', () => {
    const ring = new RingBuffer(64 * 1024);
    ring.noteGeometry(80, 24);
    ring.write(Buffer.from('x'.repeat(1000) + '\n' + 'y'.repeat(50) + '\n'));
    ring.noteGeometry(40, 24);
    ring.write(Buffer.from('z'.repeat(10)));

    const tail = readRingTailWithModesAndGeometry(ring, null, 100);
    expect(tail.raw.toString()).toBe('y'.repeat(50) + '\n' + 'z'.repeat(10));
    expect(tail.geometry?.start).toEqual({ cols: 80, rows: 24 });
    expect(tail.geometry?.changes).toEqual([{ offset: 51, cols: 40, rows: 24 }]);
  });

  it('starts at an escape sequence when the tail has no line feed', () => {
    // A TUI repainting by cursor addressing only: no LF anywhere.
    const frame = (i: number) => `\x1b[1;1Hframe ${i}\x1b[2;1Hstatus\x1b[K`;
    const ring = new RingBuffer(64 * 1024);
    ring.write(Buffer.from(Array.from({ length: 200 }, (_, i) => frame(i)).join('')));

    const tail = readRingTailWithModesAndGeometry(ring, null, 1000);
    expect(tail.raw.length).toBeGreaterThan(900);
    expect(tail.raw[0]).toBe(0x1b);
    expect(tail.raw.toString().endsWith(frame(199))).toBe(true);
  });

  it('returns the whole ring when it is smaller than the tail', () => {
    const ring = new RingBuffer(1024);
    ring.write(Buffer.from('short'));
    expect(readRingTailWithModesAndGeometry(ring, null, 4096).raw.toString()).toBe('short');
  });
});
