import { sendRpc } from '../wmux-client';
import { navigationPolicyOptions, type NavigationPolicyOptions } from '../../shared/types';

/**
 * The navigation policy's inputs for this process's preflight.
 *
 * The private-network switch is a Settings toggle that wmux main owns, and this
 * server runs in the agent's process, which can see neither main's settings
 * nor main's environment. So it asks main over the RPC channel every browser
 * tool already uses, once per navigation: the preflight and main's own check
 * then reach one verdict for one URL (#1359), and a toggle changes the very
 * next navigation on both sides.
 *
 * When main cannot answer (not running, or a build that predates the read),
 * the setting counts as off and the environment variable alone decides — the
 * closed side. A navigation that gets past this still meets main's check.
 */
export async function readNavigationPolicy(): Promise<NavigationPolicyOptions> {
  let settingOn = false;
  try {
    const reply = await sendRpc('browser.navigationPolicy.get');
    settingOn =
      typeof reply === 'object'
      && reply !== null
      && (reply as { allowPrivateNetwork?: unknown }).allowPrivateNetwork === true;
  } catch {
    // Unreachable or unknown method: settingOn stays false.
  }
  return navigationPolicyOptions(settingOn);
}
