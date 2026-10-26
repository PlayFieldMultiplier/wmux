import type { WorkerSlots } from '../main/factory/workerSlots';

/**
 * The worker-slot stores a test opens. A store coalesces its writes on a
 * timer, and a write still pending when the test ends would land after the
 * test has removed the store's dir, and make it again. settle() makes each
 * pending write now; call it from an afterEach that runs before the removal.
 */
export function workerSlotStores(): { track: (store: WorkerSlots) => WorkerSlots; settle: () => void } {
  const stores: WorkerSlots[] = [];
  return {
    track: (store) => {
      stores.push(store);
      return store;
    },
    settle: () => {
      for (const store of stores.splice(0)) store.settlePendingWriteForTests();
    },
  };
}
