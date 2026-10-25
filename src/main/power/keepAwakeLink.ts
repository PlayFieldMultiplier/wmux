// The daemon half of "Keep the computer awake" (sleepPrevention.ts).
//
// In: the daemon says whether a paired phone is attached (`phone.presence`,
// on each change and right after daemon.phone.register), and 'working' mode
// holds the blocker while one is. Out: main reports its mode and whether the
// blocker is held (`daemon.phone.keepAwake`), which a phone reads as
// `/api/config` `keepAwake`; again after each presence report, so a daemon
// that just registered this desktop has it at once.
//
// A daemon that goes away takes its "attached" with it: on 'disconnected'
// (and on dispose) the phone counts as gone, so a stale report from a dead or
// restarted daemon never keeps the computer awake.

import type { DaemonEvent } from '../../shared/rpc';
import type { KeepAwakeState } from '../../shared/sleepPrevention';

/** The slice of DaemonClient this uses. */
export interface KeepAwakeClient {
  on(event: 'event', listener: (event: DaemonEvent) => void): unknown;
  on(event: 'disconnected', listener: () => void): unknown;
  off(event: 'event', listener: (event: DaemonEvent) => void): unknown;
  off(event: 'disconnected', listener: () => void): unknown;
  rpc(method: 'daemon.phone.keepAwake', params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of SleepPrevention this uses. */
export interface KeepAwakeController {
  readonly state: KeepAwakeState;
  setPhoneAttached(attached: boolean): void;
  onState(listener: (state: KeepAwakeState) => void): () => void;
}

export function installKeepAwakeLink(client: KeepAwakeClient, controller: KeepAwakeController): () => void {
  let active = true;
  const report = (state: KeepAwakeState): void => {
    if (!active) return;
    // An older daemon has no such method; the next change tries again.
    client.rpc('daemon.phone.keepAwake', { mode: state.mode, active: state.active }).catch(() => undefined);
  };
  const onEvent = (event: DaemonEvent): void => {
    if (!active || event.type !== 'phone.presence') return;
    const data = event.data as { attached?: unknown } | undefined;
    controller.setPhoneAttached(data?.attached === true);
    report(controller.state);
  };
  const onDisconnected = (): void => controller.setPhoneAttached(false);
  client.on('event', onEvent);
  client.on('disconnected', onDisconnected);
  const offState = controller.onState(report);
  report(controller.state);
  return () => {
    if (!active) return;
    active = false;
    offState();
    client.off('event', onEvent);
    client.off('disconnected', onDisconnected);
    controller.setPhoneAttached(false);
  };
}
