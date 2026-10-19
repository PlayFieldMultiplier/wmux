/** Small, transport-independent replay contract for stateful consumers.
 * Times are arrival offsets, not timestamps claimed by the event payload.
 * A checkpoint observes all outputs so far; equal-time entries run in order.
 * advanceBy must run timers due at the target time before dispatch/checkpoint.
 */
export type ReplayStep<Input, Output> =
  | { atMs: number; input: Input }
  | { atMs: number; expect: readonly Output[] };

export interface ReplayScenario<Input, Output> {
  name: string;
  steps: readonly ReplayStep<Input, Output>[];
}

export function replayTimeline<Input, Output>(
  scenario: ReplayScenario<Input, Output>,
  driver: {
    advanceBy: (ms: number) => void;
    dispatch: (input: Input, atMs: number) => void;
    checkpoint: (expected: readonly Output[], atMs: number) => void;
  },
): void {
  let cursor = 0;
  for (const step of scenario.steps) {
    if (!Number.isFinite(step.atMs) || step.atMs < cursor) {
      throw new Error(`${scenario.name}: invalid arrival time ${step.atMs} after ${cursor}`);
    }
    driver.advanceBy(step.atMs - cursor);
    cursor = step.atMs;
    if ('input' in step) driver.dispatch(step.input, cursor);
    else driver.checkpoint(step.expect, cursor);
  }
}
