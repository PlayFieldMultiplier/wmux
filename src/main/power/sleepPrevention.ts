// Keep the computer awake while agents work (Settings › General).
//
// One Electron power-save blocker, `prevent-app-suspension`: the system does
// not sleep, the display still may. It is held while the mode says so —
// 'always', or 'working' while any local agent is working — and released when
// that stops being true: RELEASE_GRACE_MS after the last agent stops, at once
// when the mode turns it off. The renderer supplies both inputs: the mode it
// persists, and the working verdict it reads from Fleet's status model
// (selectLocalAgentsWorking), so no second detector decides what "working" is.
//
// It also records how long the system slept: 'suspend' stamps the start and
// 'resume' hands the window to `onSlept`, which tells the renderer which
// scheduled runs were missed while asleep. A resume with no suspend seen
// before it (some hibernate paths) has no window and reports nothing.

import {
  DEFAULT_SLEEP_PREVENTION_MODE,
  isSleepPreventionMode,
  type SleepPreventionMode,
  type SleepWindow,
} from '../../shared/sleepPrevention';

/** The slice of Electron's `powerSaveBlocker` this uses. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** The slice of Electron's `powerMonitor` this uses. */
export interface SleepPowerMonitor {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export interface SleepPreventionDeps {
  blocker: PowerSaveBlockerLike;
  power?: SleepPowerMonitor;
  log?: (line: string) => void;
  now?: () => number;
  onSlept?: (window: SleepWindow) => void;
}

/**
 * How long the blocker outlives the last working agent ('working' mode). A bot
 * or an orchestrator handing off between turns leaves seconds with nothing
 * running, and after hours unattended the idle timer has long expired: the
 * computer would sleep inside that gap.
 */
export const RELEASE_GRACE_MS = 75_000;

export class SleepPrevention {
  private mode: SleepPreventionMode = DEFAULT_SLEEP_PREVENTION_MODE;
  private agentsWorking = false;
  private blockerId: number | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendedAt: number | null = null;
  private readonly onSuspend = (): void => { this.suspendedAt = this.now(); };
  private readonly onResume = (): void => {
    const suspendedAt = this.suspendedAt;
    this.suspendedAt = null;
    if (suspendedAt === null) return;
    this.deps.onSlept?.({ suspendedAt, resumedAt: this.now() });
  };

  constructor(private readonly deps: SleepPreventionDeps) {
    deps.power?.on('suspend', this.onSuspend);
    deps.power?.on('resume', this.onResume);
  }

  /** The id of the held blocker, or null when none is held. */
  get heldId(): number | null {
    return this.blockerId;
  }

  /** The renderer's saved choice. Anything unknown is ignored. */
  setMode(mode: unknown): void {
    if (!isSleepPreventionMode(mode) || mode === this.mode) return;
    this.mode = mode;
    this.apply();
  }

  /** Whether any local agent is working, as Fleet counts it. */
  setAgentsWorking(working: boolean): void {
    if (working === this.agentsWorking) return;
    this.agentsWorking = working;
    this.apply();
  }

  /**
   * The renderer that reported the verdict is gone. Its last "working" must
   * not keep the computer awake with nobody left to say the agents stopped; a
   * new renderer sends its own verdict when it loads.
   */
  rendererGone(): void {
    this.agentsWorking = false;
    if (this.mode !== 'always') this.release();
  }

  dispose(): void {
    this.deps.power?.removeListener('suspend', this.onSuspend);
    this.deps.power?.removeListener('resume', this.onResume);
    this.release();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private apply(): void {
    const hold = this.mode === 'always' || (this.mode === 'working' && this.agentsWorking);
    if (hold) {
      this.cancelRelease();
      if (this.blockerId !== null && this.deps.blocker.isStarted(this.blockerId)) return;
      this.blockerId = this.deps.blocker.start('prevent-app-suspension');
      this.deps.log?.(`[power] sleep blocker on id=${this.blockerId} mode=${this.mode}`);
    } else if (this.mode === 'working' && this.blockerId !== null) {
      // The agents stopped: let go after the grace, unless one starts first.
      if (this.releaseTimer) return;
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        this.release();
      }, RELEASE_GRACE_MS);
      this.releaseTimer.unref?.();
    } else {
      this.release();
    }
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private release(): void {
    this.cancelRelease();
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    if (this.deps.blocker.isStarted(id)) this.deps.blocker.stop(id);
    this.deps.log?.(`[power] sleep blocker off id=${id} mode=${this.mode}`);
  }
}
