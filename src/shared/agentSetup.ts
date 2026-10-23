// "Agent ready" step of the first-run wizard: the status model both agent
// cards render from. Main fills it (src/main/firstRun/AgentSetupDetector.ts);
// the renderer only reads it. Nothing in here carries a credential or any of
// the agent's account details: the sign-in probe is reduced to one boolean in
// main before it crosses IPC.

import { agentRow, agentSlugsWith, type AgentSlugWith } from './agentIdentity';

/** The agents with a card: the registry rows that declare `setup`. */
export type AgentId = AgentSlugWith<'setup'>;

export const AGENT_IDS: readonly AgentId[] = agentSlugsWith('setup');

/**
 * The card states.
 *   - `ready`         installed and signed in.
 *   - `login-needed`  installed; signed out, or the sign-in check gave no usable
 *                     answer (see {@link AgentSetupStatus.loginKnown}).
 *   - `installed`     installed, and the agent has no documented sign-in check
 *                     (its row's `loginStatus` is `none`): it signs in on its
 *                     own first run, which wmux does not read.
 *   - `not-installed` no executable found.
 */
export type AgentReadiness = 'ready' | 'login-needed' | 'installed' | 'not-installed';

export interface AgentSetupStatus {
  agent: AgentId;
  readiness: AgentReadiness;
  /** Absolute path of the executable that was probed; null when not installed. */
  executable: string | null;
  /** `x.y.z` read from `--version`; null when it could not be read. */
  version: string | null;
  /** Older than {@link AGENT_UPDATE_FLOORS}. A hint only: nothing is forced. */
  updateRecommended: boolean;
  /**
   * False when the sign-in probe timed out or printed something unexpected.
   * readiness is then `login-needed` and the card says it could not tell,
   * rather than claiming the user is signed out.
   */
  loginKnown: boolean;
  /** Where wmux looked, for the "installed but not found" case. Empty when found. */
  candidates: string[];
}

/**
 * "Update recommended" below this version: the row's `setup.updateFloor`, the
 * oldest agent version whose behaviour wmux code records relying on (the
 * reason sits next to each floor in agentIdentity.ts). Updated with app
 * releases, never fetched.
 */
export function agentUpdateFloor(agent: AgentId): string | null {
  return agentRow(agent)?.setup?.updateFloor ?? null;
}

/** First `x.y.z` in a `--version` line (`2.1.305 (Claude Code)`, `codex-cli 0.163.0`). */
export function parseAgentVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** True when `version` is strictly older than `floor` (both `x.y.z`). */
export function isOlderVersion(version: string, floor: string): boolean {
  const a = version.split('.').map((n) => Number(n) || 0);
  const b = floor.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** At least one agent can be used now: the wizard may continue. */
export function anyAgentReady(statuses: readonly AgentSetupStatus[]): boolean {
  return statuses.some((s) => s.readiness === 'ready');
}

/** At least one agent is set up as far as wmux can tell: signed in, or
 *  installed with a sign-in it cannot check. What the sidebar's "Agent not
 *  set up" row and the wizard's Later label ask. */
export function anyAgentSetUp(statuses: readonly AgentSetupStatus[]): boolean {
  return statuses.some((s) => s.readiness === 'ready' || s.readiness === 'installed');
}
