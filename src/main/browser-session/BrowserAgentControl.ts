import {
  agentControlCancelMessage,
  agentControlRefusalMessage,
  refusalCodeForMode,
  type BrowserAgentControlIntent,
  type BrowserAgentControlMode,
  type BrowserAgentControlState,
} from '../../shared/browserAgentControl';

/**
 * How long the "agent is driving" marker stays lit after the last agent action
 * on a tab ends. Agents act in quick steps (snapshot, click, snapshot); without
 * a short linger the marker would blink off and on between them.
 */
export const AGENT_ACTIVITY_LINGER_MS = 1_500;

export interface BrowserAgentControlDeps {
  /** Push one surface's new state to the renderer. */
  emit: (state: BrowserAgentControlState) => void;
  /**
   * Cancel whatever agent action is in flight on the surface, failing it with
   * `error`. Called on Stop and Take over, after the mode has changed, so a
   * holder that reacts by retrying is already refused.
   */
  cancelInFlight: (surfaceId: string, error: Error) => void;
  lingerMs?: number;
}

/**
 * Per-surface agent control for in-app browser tabs, owned by main.
 *
 *   agent --stop--> paused --resume--> agent
 *   agent|paused --takeOver--> user --handBack--> agent
 *
 * Any other intent leaves the state as it is. The only callers of the intents
 * are the renderer's controls (through a trusted-sender IPC handler); agents
 * reach `refusal` alone, so no agent can clear a pause or a take-over.
 *
 * Activity is not guessed: `noteLeases` is fed the automation lease count for
 * the surface, which every agent browser action holds while it runs (the MCP
 * lane's browser.lease.* and main's own leased browser.* handlers).
 */
export class BrowserAgentControl {
  private readonly modes = new Map<string, Exclude<BrowserAgentControlMode, 'agent'>>();
  /** Surfaces whose marker is lit (leases held, or inside the linger). */
  private readonly active = new Set<string>();
  /** Surfaces with at least one lease held right now. */
  private readonly leased = new Set<string>();
  private readonly offTimers = new Map<string, NodeJS.Timeout>();
  private readonly lingerMs: number;

  constructor(private readonly deps: BrowserAgentControlDeps) {
    this.lingerMs = deps.lingerMs ?? AGENT_ACTIVITY_LINGER_MS;
  }

  get(surfaceId: string): BrowserAgentControlState {
    return { surfaceId, active: this.active.has(surfaceId), mode: this.modes.get(surfaceId) ?? 'agent' };
  }

  /** Every surface that is not idle-and-agent: what a reloaded renderer needs. */
  list(): BrowserAgentControlState[] {
    const ids = new Set<string>([...this.active, ...this.modes.keys()]);
    return [...ids].map((id) => this.get(id));
  }

  /**
   * The error an agent call on `surfaceId` must fail with, or null when agents
   * may act on it. `method` names the call in the message, like main's other
   * browser refusals.
   */
  refusal(surfaceId: string | undefined, method: string): Error | null {
    if (!surfaceId) return null;
    const code = refusalCodeForMode(this.modes.get(surfaceId) ?? 'agent');
    return code ? new Error(agentControlRefusalMessage(method, code)) : null;
  }

  /** The surface's automation lease count changed. */
  noteLeases(surfaceId: string, count: number): void {
    if (count > 0) {
      this.leased.add(surfaceId);
      const timer = this.offTimers.get(surfaceId);
      if (timer) {
        clearTimeout(timer);
        this.offTimers.delete(surfaceId);
      }
      if (!this.active.has(surfaceId)) {
        this.active.add(surfaceId);
        this.emit(surfaceId);
      }
      return;
    }
    this.leased.delete(surfaceId);
    if (!this.active.has(surfaceId) || this.offTimers.has(surfaceId)) return;
    const timer = setTimeout(() => {
      this.offTimers.delete(surfaceId);
      if (this.leased.has(surfaceId)) return;
      this.active.delete(surfaceId);
      this.emit(surfaceId);
    }, this.lingerMs);
    timer.unref?.();
    this.offTimers.set(surfaceId, timer);
  }

  /** Apply one user intent. `changed` is false when it did not apply. */
  apply(surfaceId: string, intent: BrowserAgentControlIntent): { changed: boolean; state: BrowserAgentControlState } {
    const mode = this.modes.get(surfaceId) ?? 'agent';
    const next = nextMode(mode, intent);
    if (next === mode) return { changed: false, state: this.get(surfaceId) };
    if (next === 'agent') this.modes.delete(surfaceId);
    else this.modes.set(surfaceId, next);
    const code = refusalCodeForMode(next);
    // Stop and Take over end the agent's current action as well as the next ones.
    if (code) this.deps.cancelInFlight(surfaceId, new Error(agentControlCancelMessage(code)));
    this.emit(surfaceId);
    return { changed: true, state: this.get(surfaceId) };
  }

  private emit(surfaceId: string): void {
    try {
      this.deps.emit(this.get(surfaceId));
    } catch {
      /* a closed window must not break the bookkeeping */
    }
  }
}

function nextMode(mode: BrowserAgentControlMode, intent: BrowserAgentControlIntent): BrowserAgentControlMode {
  switch (intent) {
    case 'stop':
      return mode === 'agent' ? 'paused' : mode;
    case 'resume':
      return mode === 'paused' ? 'agent' : mode;
    case 'takeOver':
      return mode === 'user' ? mode : 'user';
    case 'handBack':
      return mode === 'user' ? 'agent' : mode;
  }
}
