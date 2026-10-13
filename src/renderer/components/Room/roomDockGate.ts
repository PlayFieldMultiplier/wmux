// ─── Whether the factory is on, for the room dock ───────────────────────────
//
// The right slot always holds the room dock, open on the panel's own flag
// (`channelDockVisible`, AppLayout); with the factory off the dock shows its
// off state. `roomStatus` is null until main's first answer; until then the
// last answer seen (a localStorage hint) stands in for it.
import { useEffect } from 'react';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';

export const FACTORY_ON_HINT_KEY = 'wmux.factory.enabledHint';

function readHint(): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(FACTORY_ON_HINT_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

const bootHint = readHint();

/** The factory is on, for the dock: main's answer, else the last one seen. */
export function selectRoomDockOn(s: Pick<StoreState, 'roomStatus'>): boolean {
  return s.roomStatus ? s.roomStatus.enabled : bootHint === true;
}

/** Keeps the boot hint current. */
export function useRoomDockHint(): void {
  const known = useStore((s) => (s.roomStatus ? s.roomStatus.enabled : null));
  useEffect(() => {
    if (known === null) return;
    try {
      globalThis.localStorage?.setItem(FACTORY_ON_HINT_KEY, known ? '1' : '0');
    } catch {
      // storage unavailable: the hint is a convenience only
    }
  }, [known]);
}
