import type { RingBuffer } from './RingBuffer';
import { generateTextSnapshotUnqueued, type TextSnapshotOutcome } from './HeadlessSnapshot';
import { readRingWithModesAndGeometry, readSessionTextReplay } from './sessionTextReplay';
import type { OutputModeTracker } from './util/outputModeTracker';

/** Caller holds the global snapshot slot. Only the frozen copy survives yields. */
export async function snapshotRingTextUnqueued(ring: RingBuffer, modes: Pick<OutputModeTracker, 'preamble'> | null,
  options: { cols: number; rows: number; scrollback?: number; undimmed?: boolean; budgetMs?: number; replayGeometry?: boolean }): Promise<TextSnapshotOutcome> {
  const source = ring.freezeNative();
  if (!source) {
    if (!options.replayGeometry) return generateTextSnapshotUnqueued({ ...options, initial: readSessionTextReplay(ring, modes) });
    const { replay: initial, geometry } = readRingWithModesAndGeometry(ring, modes);
    return generateTextSnapshotUnqueued({ ...options, initial, geometry });
  }
  try {
    // The ring's lifetime offset: a ring re-created after hibernation counts
    // its native `writtenAt` from the wake, not from the session start.
    const initial = Buffer.from(modes?.preamble(ring.totalBytesWritten - source.size) ?? '', 'utf8');
    // Preserve each caller's existing replay contract. readSessionText uses
    // one current size; callers already replaying geometry can request it.
    return await generateTextSnapshotUnqueued({ ...options, initial, nativeSource: source, geometry: options.replayGeometry ? source.geometry ?? undefined : undefined });
  } finally { source.dispose(); }
}
