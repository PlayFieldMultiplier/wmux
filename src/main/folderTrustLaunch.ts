import type { DaemonClient } from './DaemonClient';
import { FOLDER_TRUST_LAUNCH_REFUSAL } from '../shared/folderTrustWording';

/** How long a launch writer waits for the daemon's verdict (above its 250 ms read). */
const FOLDER_TRUST_LAUNCH_TIMEOUT_MS = 400;

/**
 * Why main must not type a launch line or key into `ptyId` now, or null.
 * 'trust' always refuses; 'unknown' only when `refuseUnknown` (an automated
 * line), never for a line a person clicked to type. With no daemon verdict to have (no daemon,
 * an older one, no answer in time) the line is typed as before. One log line
 * per refusal, naming the writer and the verdict.
 */
export async function folderTrustLaunchRefusal(
  dc: Pick<DaemonClient, 'folderTrustState'> | null | undefined,
  ptyId: string,
  writer: string,
  opts: { refuseUnknown: boolean },
): Promise<string | null> {
  if (!dc) return null;
  const answer = await dc.folderTrustState(ptyId, FOLDER_TRUST_LAUNCH_TIMEOUT_MS);
  if (!('state' in answer)) return null;
  const verdict = answer.state;
  if (verdict === 'clear' || (verdict === 'unknown' && !opts.refuseUnknown)) return null;
  console.warn(`[folder-trust] refused ${writer} on pane ${ptyId}: folder-trust ${verdict}`);
  return verdict === 'trust'
    ? FOLDER_TRUST_LAUNCH_REFUSAL
    : 'the pane has no readable screen, so a folder-trust prompt cannot be ruled out';
}
