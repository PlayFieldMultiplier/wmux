// ─── The Hermes bot engine's readiness (FACTORY_HERMES_READINESS) ──────────
//
// Whether a bot on Hermes Agent (Nous Research) can run on this computer,
// answered without a model turn: `hermes` is found, its version is in the
// range wmux was tested against, wmux's own Hermes home has a model, and the
// settings wmux writes there read back as written (main/factory/
// hermesEngine.ts). Never carries a credential or any part of one.

/** The Hermes Agent project page (https only; opened via shell.openExternal). */
export const HERMES_INSTALL_URL = 'https://github.com/NousResearch/hermes-agent';

/** The oldest Hermes wmux runs bots on. */
export const HERMES_VERSION_MIN = '0.22.5';
/** The first Hermes release wmux has not been tested against. */
export const HERMES_VERSION_BELOW = '0.23.0';

export type HermesNotReadyReason =
  | 'not-installed'
  /** Older than HERMES_VERSION_MIN: the owner updates Hermes. */
  | 'outdated'
  /** At or past HERMES_VERSION_BELOW: wmux has not been tested on it. */
  | 'unsupported'
  /** wmux's Hermes home has no model yet: the owner runs the setup once. */
  | 'not-set-up'
  /** A setting wmux writes does not read back as written. */
  | 'config-mismatch'
  | 'unknown';

export interface HermesReadiness {
  ready: boolean;
  /** Set when `ready` is false. */
  reason?: HermesNotReadyReason;
  /** The version `hermes --version` reported, when one was read. */
  version?: string;
  /** A short, credential-free detail for the owner (English). */
  message?: string;
}

/** `X.Y.Z` from `hermes --version` output ("Hermes Agent v0.22.5 (…)"), or
 *  null. Pure. */
export function parseHermesVersion(text: string): string | null {
  const m = /\bv?(\d{1,4})\.(\d{1,4})\.(\d{1,6})\b/.exec(typeof text === 'string' ? text.split('\n', 1)[0] : '');
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Where `version` (X.Y.Z) stands against the tested range. Pure. */
export function hermesVersionStatus(version: string): 'ok' | 'outdated' | 'unsupported' {
  if (compareVersions(version, HERMES_VERSION_MIN) < 0) return 'outdated';
  if (compareVersions(version, HERMES_VERSION_BELOW) >= 0) return 'unsupported';
  return 'ok';
}
