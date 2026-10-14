/**
 * #2101 — a timeline of a mirror cell's attach runs, for the log.
 *
 * A cell left at `attachId: null` with no error means its last attach run
 * never got an answer it was allowed to keep. Main answers the attach and the
 * detach synchronously, so the open question is on the renderer side: was the
 * run still waiting on the previous run's teardown, was the attach sent and
 * never answered, or did the dependencies keep changing (`attachEpoch`
 * flapping while a new host first connects, `sessionId` arriving late)? The
 * cell records each run's steps here and logs them once when a run stays
 * unattached past ATTACH_STUCK_MS. Nothing here changes what the cell does.
 */

/** How long a run may wait for its attach before the cell logs its timeline. */
export const ATTACH_STUCK_MS = 5_000;

interface AttachRun {
  id: number;
  deps: string;
  startedAt: number;
  steps: string[];
}

export class AttachTimeline {
  private readonly runs: AttachRun[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** Runs kept, newest last; older ones are dropped. */
    private readonly keep = 3,
  ) {}

  /** A new effect run with these dependencies. Returns its id. */
  start(deps: string): number {
    this.seq += 1;
    this.runs.push({ id: this.seq, deps, startedAt: this.now(), steps: ['start@0'] });
    if (this.runs.length > this.keep) this.runs.shift();
    return this.seq;
  }

  /** One step of a run, stamped with the ms since that run started. */
  note(run: number, step: string): void {
    const r = this.runs.find((x) => x.id === run);
    if (r) r.steps.push(`${step}@${this.now() - r.startedAt}`);
  }

  /** Ms since the run started, or -1 when it is no longer kept. */
  age(run: number): number {
    const r = this.runs.find((x) => x.id === run);
    return r ? this.now() - r.startedAt : -1;
  }

  /** Every kept run, oldest first: `#2 epoch=1 session=ab12cd34 [start@0 cancelled@40] | #3 …`. */
  describe(): string {
    return this.runs.map((r) => `#${r.id} ${r.deps} [${r.steps.join(' ')}]`).join(' | ');
  }
}
