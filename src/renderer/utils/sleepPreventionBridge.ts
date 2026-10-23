// The renderer's half of "Keep the computer awake" (main/power/sleepPrevention.ts).
//
// Main holds the blocker; this sends it the two things only the renderer
// knows: the mode the user picked (persisted with the session), and whether
// any local agent is working, read from Fleet's status model
// (selectLocalAgentsWorking) rather than a detector of its own. Each is sent
// once on install, so a reloaded renderer re-primes main, then on every
// change. Main's report of a sleep comes back the other way, for the
// missed-while-asleep notice on the Schedules page.

import type { SleepPreventionMode, SleepWindow } from '../../shared/sleepPrevention';
import { selectLocalAgentsWorking, type FleetBoardState } from '../stores/selectors/fleet';

export interface SleepPowerApi {
  setSleepMode: (mode: SleepPreventionMode) => void;
  setAgentsWorking: (working: boolean) => void;
  onSlept: (callback: (window: SleepWindow) => void) => () => void;
}

type BridgeState = FleetBoardState & {
  sleepPreventionMode: SleepPreventionMode;
  recordSleepWindow: (window: SleepWindow) => void;
};

export interface BridgeStore<S> {
  getState: () => S;
  subscribe: (listener: (state: S) => void) => () => void;
}

export function installSleepPreventionBridge<S extends BridgeState>(store: BridgeStore<S>, power: SleepPowerApi | undefined): () => void {
  if (!power) return () => undefined;
  let mode = store.getState().sleepPreventionMode;
  let working = selectLocalAgentsWorking(store.getState());
  power.setSleepMode(mode);
  power.setAgentsWorking(working);
  const unsubscribe = store.subscribe((state) => {
    if (state.sleepPreventionMode !== mode) {
      mode = state.sleepPreventionMode;
      power.setSleepMode(mode);
    }
    const next = selectLocalAgentsWorking(state);
    if (next !== working) {
      working = next;
      power.setAgentsWorking(working);
    }
  });
  const offSlept = power.onSlept((window) => store.getState().recordSleepWindow(window));
  return () => {
    unsubscribe();
    offSlept();
  };
}
