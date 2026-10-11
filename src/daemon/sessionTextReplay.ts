import type { RingBuffer, ReplayGeometry } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';

/**
 * The ring's bytes (`raw`) and the same bytes led by the mode preamble
 * (`replay`), which restores terminal modes whose entry sequences have fallen
 * out of the ring.
 */
export function readRingWithModes(
  ring: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): { raw: Buffer; replay: Buffer } {
  // Capture the bytes and their absolute offset without yielding, so the mode
  // tracker and replay describe the same point in the output stream.
  const raw = ring.readAll();
  const startOffset = ring.totalBytesWritten - raw.length;
  const preamble = outputModes?.preamble(startOffset) ?? '';
  return { raw, replay: preamble ? Buffer.concat([Buffer.from(preamble, 'utf8'), raw]) : raw };
}

/** Restore terminal modes whose entry sequences have fallen out of the ring. */
export function readSessionTextReplay(
  ring: Pick<RingBuffer, 'readAll' | 'totalBytesWritten'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): Buffer {
  return readRingWithModes(ring, outputModes).replay;
}

/**
 * readRingWithModes plus the sizes the bytes were written at (#1825), with the
 * size-change offsets moved past the preamble so they still point at the same
 * ring bytes inside `replay`. The preamble only sets modes, so parsing it at
 * the start size is exact. `writtenAt` is the ring's lifetime byte count at
 * the read, which locates the bytes that arrive after it.
 */
export function readRingWithModesAndGeometry(
  ring: Pick<RingBuffer, 'readAllWithGeometry'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
): { raw: Buffer; replay: Buffer; geometry: ReplayGeometry | undefined; writtenAt: number } {
  const { data: raw, geometry, writtenAt } = ring.readAllWithGeometry();
  const preamble = outputModes?.preamble(writtenAt - raw.length) ?? '';
  if (!preamble) return { raw, replay: raw, geometry, writtenAt };
  const lead = Buffer.from(preamble, 'utf8');
  return {
    raw,
    replay: Buffer.concat([lead, raw]),
    geometry: geometry && {
      start: geometry.start,
      changes: geometry.changes.map((c) => ({ ...c, offset: c.offset + lead.length })),
    },
    writtenAt,
  };
}

/**
 * The newest `maxBytes` of the ring, cut forward to the next line start (or,
 * when that stretch has no line feed at all, to the next escape sequence), as
 * a replay of its own: the preamble is computed for where the tail starts (modes
 * set earlier in the ring are restored, modes the tail sets itself are left to
 * it) and the geometry starts at the size in force there.
 *
 * For the attach snapshot's second try: when the whole ring cannot be parsed
 * inside the budget, the screen is rebuilt from recent output only. Older
 * scrollback is lost, but the screen comes out right, where a raw replay of a
 * cursor-addressed app's history interleaves its redraws into garbage.
 */
export function readRingTailWithModesAndGeometry(
  ring: Pick<RingBuffer, 'readAllWithGeometry'>,
  outputModes: Pick<OutputModeTracker, 'preamble'> | null,
  maxBytes: number,
): { raw: Buffer; replay: Buffer; geometry: ReplayGeometry | undefined; writtenAt: number } {
  const { data, geometry, writtenAt } = ring.readAllWithGeometry();
  let cut = Math.max(0, data.length - maxBytes);
  if (cut > 0) {
    // Start on a line: a cut mid-sequence or mid-character would parse its
    // remains as text. A TUI that repaints by cursor addressing alone writes
    // no line feeds, and cutting past all of its output would leave a blank
    // screen, so it starts at an escape sequence instead (ESC is ASCII: never
    // inside a UTF-8 character).
    const nl = data.indexOf(0x0a, cut);
    const esc = nl === -1 ? data.indexOf(0x1b, cut) : -1;
    cut = nl !== -1 ? nl + 1 : esc !== -1 ? esc : data.length;
  }
  const raw = data.subarray(cut);
  const preamble = outputModes?.preamble(writtenAt - raw.length) ?? '';
  const lead = Buffer.from(preamble, 'utf8');
  let tailGeometry: ReplayGeometry | undefined;
  if (geometry) {
    let start = geometry.start;
    const changes: ReplayGeometry['changes'] = [];
    for (const c of geometry.changes) {
      if (c.offset <= cut) start = { cols: c.cols, rows: c.rows };
      else changes.push({ ...c, offset: c.offset - cut + lead.length });
    }
    tailGeometry = { start, changes };
  }
  return {
    raw,
    replay: lead.length > 0 ? Buffer.concat([lead, raw]) : raw,
    geometry: tailGeometry,
    writtenAt,
  };
}
