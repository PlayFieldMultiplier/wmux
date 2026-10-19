// One counter every store the holder set reads bumps when it changes
// (workerHolders.ts): a look at the holder set is reused only while this
// counter has not moved, within one turn of the event loop. A change may
// free a worker slot, so the listeners hear of it too (heldFanouts.ts).

let revision = 0;
const listeners = new Set<() => void>();

/** A record the holder set reads changed (a booking, a grant, a launch, a
 *  reclaim record, a verdict, a gone fact). */
export function holderInputsChanged(): void {
  revision++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener never breaks the store that changed */
    }
  }
}

/** Hear of every change above; returns the unsubscribe. A listener must be
 *  cheap: it runs inside the store's write. */
export function onHolderInputsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Moves on every change above. */
export function holderInputsRevision(): number {
  return revision;
}
