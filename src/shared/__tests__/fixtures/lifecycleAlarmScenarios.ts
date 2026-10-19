import type { AgentSignal } from '../../hooks/signal-types';
import type { ReplayScenario } from './replayTimeline';

export type AlarmReplayInput =
  | { source: 'hook'; kind: AgentSignal['kind']; payload?: AgentSignal['payload'] }
  | { source: 'detector'; status: 'running' | 'waiting' | 'complete' | 'awaiting_input' };

export interface AlarmReplayOutput {
  atMs: number;
  status: 'complete' | 'error' | 'awaiting_input';
}

const prompt: AlarmReplayInput = { source: 'hook', kind: 'agent.user_prompt_submit' };
const stop: AlarmReplayInput = { source: 'hook', kind: 'agent.stop' };
const failure: AlarmReplayInput = { source: 'hook', kind: 'agent.stop_failure' };
const child: AlarmReplayInput = { source: 'hook', kind: 'agent.subagent_stop' };
const answer: AlarmReplayInput = { source: 'hook', kind: 'agent.input_answered' };
const waiting: AlarmReplayInput = { source: 'detector', status: 'waiting' };

// Synthetic, sanitized arrival traces, deliberately shared by the pure alarm
// and daemon ingress adapters. The explicit 1499/1500 ms checkpoints make the
// existing hold observable. These assert alarms, not every pane status update.
export const lifecycleAlarmScenarios: readonly ReplayScenario<AlarmReplayInput, AlarmReplayOutput>[] = [
  {
    name: 'completion: child stop is inert, duplicate lead stop replaces the hold only before confirmation',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: stop },
      { atMs: 200, input: child },
      { atMs: 250, input: stop },
      { atMs: 1_749, expect: [] },
      { atMs: 1_750, expect: [{ atMs: 1_750, status: 'complete' }] },
      { atMs: 1_800, input: stop },
      { atMs: 1_900, input: child },
      { atMs: 3_400, expect: [{ atMs: 1_750, status: 'complete' }] },
    ],
  },
  {
    name: 'failure: delayed generic stop, detector repaint, answer and dialog cannot erase the error',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: failure },
      { atMs: 200, input: stop },
      { atMs: 300, input: waiting },
      { atMs: 400, input: answer },
      { atMs: 500, input: { source: 'hook', kind: 'agent.awaiting_input' } },
      { atMs: 1_599, expect: [] },
      { atMs: 1_600, expect: [{ atMs: 1_600, status: 'error' }] },
      { atMs: 1_700, input: stop },
      { atMs: 3_300, expect: [{ atMs: 1_600, status: 'error' }] },
    ],
  },
  {
    name: 'cancellation: an interrupted stop cancels the held success and a later repaint stays silent',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 50, input: stop },
      { atMs: 100, input: { source: 'hook', kind: 'agent.stop', payload: { wmux_turn_reason: 'aborted' } } },
      { atMs: 200, input: waiting },
      { atMs: 1_700, expect: [] },
      { atMs: 2_000, input: prompt },
      { atMs: 2_100, input: stop },
      { atMs: 3_599, expect: [] },
      { atMs: 3_600, expect: [{ atMs: 3_600, status: 'complete' }] },
    ],
  },
  {
    name: 'retry: new work rebuts the pending failure and can finish successfully',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: failure },
      { atMs: 200, input: prompt },
      { atMs: 300, input: stop },
      { atMs: 1_600, expect: [] },
      { atMs: 1_799, expect: [] },
      { atMs: 1_800, expect: [{ atMs: 1_800, status: 'complete' }] },
    ],
  },
  {
    name: 'session restart: cancels failure, ignores idle stop, then allows a new turn',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: failure },
      { atMs: 200, input: { source: 'hook', kind: 'agent.session_start' } },
      { atMs: 250, input: stop },
      { atMs: 400, input: prompt },
      { atMs: 500, input: stop },
      { atMs: 1_600, expect: [] },
      { atMs: 1_999, expect: [] },
      { atMs: 2_000, expect: [{ atMs: 2_000, status: 'complete' }] },
    ],
  },
  {
    name: 'late work: detector activity one millisecond before expiry cancels the old success',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: stop },
      { atMs: 1_599, input: { source: 'detector', status: 'running' } },
      { atMs: 1_600, expect: [] },
      { atMs: 1_600, input: stop },
      { atMs: 3_099, expect: [] },
      { atMs: 3_100, expect: [{ atMs: 3_100, status: 'complete' }] },
    ],
  },
  {
    name: 'duplicate outlets: detector then hook then detector produce a single alarm',
    steps: [
      { atMs: 0, input: prompt },
      { atMs: 100, input: waiting },
      { atMs: 200, input: stop },
      { atMs: 1_699, expect: [] },
      { atMs: 1_700, expect: [{ atMs: 1_700, status: 'complete' }] },
      { atMs: 1_800, input: waiting },
      { atMs: 3_400, expect: [{ atMs: 1_700, status: 'complete' }] },
    ],
  },
];
