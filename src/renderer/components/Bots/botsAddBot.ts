// Adding a bot from the Bots page: the way to the factory's settings (a
// build whose bot port cannot create bots in place), turning the bots on as
// part of adding one, and the create itself.
import { useStore } from '../../stores';
import { refreshRoomStatus } from '../../hooks/useRoomSync';
import type { FactoryBotCreateRequest, FactoryBotCreateResult } from '../../../shared/botCreate';
import type { FactoryBotPort, FactorySettingsPort } from '../Room/factoryPorts';

/** The factory's settings page (Settings › Bots), by its tab id. */
export const FACTORY_SETTINGS_TAB = 'factory';

export function openFactorySettings(): void {
  useStore.getState().openSettingsTab(FACTORY_SETTINGS_TAB);
}

/** Turn the bots on (the setting Settings' switch writes) and re-read the
 *  page's gate. False: main did not take it (the runtime has not started). */
export async function turnBotsOn(settings: Pick<FactorySettingsPort, 'set'>): Promise<boolean> {
  const next = await settings.set({ enabled: true });
  await refreshRoomStatus();
  return !!next?.enabled;
}

/** A create right after the bots were turned on may meet a runtime still
 *  starting: it is asked again a few times, briefly. */
const NOT_STARTED_RETRIES = 3;
const NOT_STARTED_WAIT_MS = 400;

/** Create one bot; `not_started` is retried briefly. */
export async function createBot(
  port: Pick<FactoryBotPort, 'create'>,
  req: FactoryBotCreateRequest,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<FactoryBotCreateResult> {
  if (!port.create) return { ok: false, code: 'not_started', message: 'no bot runtime' };
  let r = await port.create(req);
  for (let i = 0; i < NOT_STARTED_RETRIES && !r.ok && r.code === 'not_started'; i += 1) {
    await wait(NOT_STARTED_WAIT_MS);
    r = await port.create(req);
  }
  return r;
}
