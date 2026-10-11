/**
 * Detection agreement — how often the screen detector agrees with the hook.
 *
 * On a pane whose hook bridge speaks for the agent, the AgentDetector keeps
 * reading the screen; the daemon only vetoes what it says (see
 * HookIngest.arbitrateDetector). So one pane at one moment carries two
 * opinions: the hook's, which is deterministic and serves as ground truth, and
 * the detector's, which is regex over the screen. The daemon records both as
 * raw transitions (daemon/diagnostics/detectionAgreementLog.ts); this module
 * replays those records offline and judges every detector read and every hook
 * edge.
 *
 * Pure: no fs, no clock, no process state. The grace window is a parameter, so
 * the same records can be judged again with a different window without
 * collecting them again.
 *
 * What the headline rate stands for: the detector's quality on agents that HAVE
 * hooks, used as a proxy for the agents that do not (where the detector is the
 * only source and no ground truth exists). It does not cover the byte-activity
 * running dot, which is entangled with hook state and cannot be shadowed.
 */

import { redactSecrets } from './redactSecrets';

export const DETECTION_LOG_VERSION = 1;

/** Default window for matching a detector read to a hook edge (either order). */
export const DEFAULT_DETECTION_GRACE_MS = 5_000;

/** Pane state as the hook reports it. */
export type HookTruth = 'busy' | 'awaiting' | 'idle';

export interface DetectionStartRecord {
  v: 1;
  type: 'start';
  t: number;
  /** App version that spawned the daemon. */
  app: string;
  os: string;
}

export interface DetectionHookRecord {
  v: 1;
  t: number;
  /** Session (pty) id. */
  s: string;
  /** Agent slug. */
  a: string;
  src: 'hook';
  h: HookTruth;
  /** Hook signal kind that caused the transition, or `transcript.turn_end`. */
  k: string;
  /** A Codex stop the transcript has not confirmed: never used as truth. */
  pv?: true;
}

export interface DetectionDetectorRecord {
  v: 1;
  t: number;
  s: string;
  a: string;
  src: 'det';
  /** Detector status as emitted (running / waiting / complete / awaiting_input / error). */
  st: string;
  /** Arbitration decision the daemon stamped on the read, when any. */
  d?: string;
  /** Rule label (the detector message, truncated). */
  r?: string;
}

export type DetectionSkipReason = 'brain' | 'inexact-routing' | 'no-turn-start';

export interface DetectionSkipRecord {
  v: 1;
  t: number;
  s: string;
  a: string;
  src: 'skip';
  why: DetectionSkipReason;
}

export type DetectionRecord =
  | DetectionStartRecord
  | DetectionHookRecord
  | DetectionDetectorRecord
  | DetectionSkipRecord;

/**
 * The pane state a hook signal establishes, or null when the signal says
 * nothing about it.
 *
 * Mostly the phone liveness projection (daemon/hooks/agentLiveness.ts), with
 * two deliberate differences, both about what the screen can show:
 *   - `agent.session_start` is idle. The liveness header shows a fresh session
 *     as working; as ground truth, a fresh session sits at its prompt.
 *   - `agent.awaiting_permission` is busy. It is wmux's own PreToolUse gate,
 *     sent for every tool call and answered by the daemon or the phone; the
 *     agent draws no dialog for it. The agent's own dialog arrives as
 *     `agent.awaiting_input` (Claude's PermissionRequest, AskUserQuestion).
 */
export function hookTruthFor(kind: string, status: string): HookTruth | null {
  switch (kind) {
    case 'agent.session_start':
      return 'idle';
    case 'agent.awaiting_input':
      return 'awaiting';
    case 'agent.stop':
    case 'agent.stop_failure':
      // A lead stop with background work left still projects `running` (#1096).
      return status === 'running' ? 'busy' : 'idle';
    case 'agent.user_prompt_submit':
    case 'agent.awaiting_permission':
    case 'agent.activity':
    case 'agent.tool_started':
    case 'agent.input_answered':
    case 'agent.permission_answered':
      return 'busy';
    default:
      // agent.subagent_stop and anything unknown: the lead turn's state stands.
      return null;
  }
}

/** The pane state a detector status claims, or null for a status that claims none. */
export function detectorReadClass(status: string): HookTruth | null {
  switch (status) {
    case 'running':
      return 'busy';
    case 'waiting':
    case 'complete':
    case 'error':
      return 'idle';
    case 'awaiting_input':
      return 'awaiting';
    default:
      return null;
  }
}

export type DetectionOutcome =
  | 'false_idle'
  | 'false_busy'
  | 'false_awaiting'
  | 'unconfirmed_awaiting'
  | 'missed_idle'
  | 'missed_awaiting';

export interface DetectionOffsetSummary {
  /** Matched pairs that carry a time offset. */
  count: number;
  /** Pairs where the detector read came before the hook edge. */
  led: number;
  /** |detector − hook| percentiles in ms. Null when count is 0. */
  p50: number | null;
  p95: number | null;
}

export interface AgentDetectionStats {
  /** Detector reads judged against a known hook truth. */
  reads: number;
  /** Hook transitions into idle or awaiting. */
  hookEdges: number;
  agree: number;
  /** Read disagreed at first, then the hook moved to it within the grace window. */
  early: number;
  falseIdle: number;
  falseBusy: number;
  falseAwaiting: number;
  /** Detector saw a dialog while the hook said busy and never confirmed it. Not an error: approval prompts often have no hook. */
  unconfirmedAwaiting: number;
  hitIdle: number;
  hitAwaiting: number;
  missedIdle: number;
  missedAwaiting: number;
  /** False reads that were not vetoed or held, so they reached the screen. */
  leaked: number;
  /**
   * False reads held for a confirmation window. Each reached the screen when
   * the window ran out unless an activity cue rebutted it first; the log does
   * not record which.
   */
  held: number;
  /** Detector reads seen before any hook truth (log starts mid-session). */
  noTruth: number;
  /** Codex stops the transcript had not confirmed; ignored as truth. */
  provisionalStops: number;
  offsetMs: DetectionOffsetSummary;
  /** False reads per rule label. */
  falseByRule: Record<string, number>;
}

export interface DetectionSample {
  t: number;
  s: string;
  a: string;
  outcome: DetectionOutcome;
  /** Detector status for read outcomes. */
  read?: string;
  /** Hook truth when the read was made, for read outcomes. */
  truth?: HookTruth;
  rule?: string;
  decision?: string;
}

export interface DetectionReport {
  graceMs: number;
  /** First and last counted record time. Null when nothing was counted. */
  from: number | null;
  to: number | null;
  /** App versions in the order their daemons started. */
  apps: string[];
  agents: Record<string, AgentDetectionStats>;
  /**
   * Distinct sessions never measured, per reason. A session skipped at first
   * (every pane is `no-turn-start` until its first prompt) and measured later
   * is not counted.
   */
  skipped: Record<DetectionSkipReason, number>;
  /** Most recent error outcomes, newest last. */
  samples: DetectionSample[];
}

export interface DetectionAnalysisOptions {
  graceMs?: number;
  /** Only records at or after this time are counted; earlier ones still set state. */
  since?: number;
  /** How many recent error samples to keep (default 20). */
  sampleLimit?: number;
}

/** Errors over everything judged: false reads plus missed edges. Null when nothing was judged. */
export function detectionErrorRate(stats: AgentDetectionStats): number | null {
  const judged = stats.reads + stats.hookEdges;
  if (judged === 0) return null;
  const errors = stats.falseIdle + stats.falseBusy + stats.falseAwaiting
    + stats.missedIdle + stats.missedAwaiting;
  return errors / judged;
}

/** Parse NDJSON log text. Lines that are not valid v1 records are dropped. */
export function parseDetectionLog(text: string): DetectionRecord[] {
  const out: DetectionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isDetectionRecord(raw)) continue;
    // A log written before redaction (or by hand) still never prints a key.
    const r = raw as { r?: unknown };
    if (typeof r.r === 'string') r.r = redactSecrets(r.r);
    out.push(raw);
  }
  return out;
}

function isDetectionRecord(raw: unknown): raw is DetectionRecord {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== DETECTION_LOG_VERSION || typeof r['t'] !== 'number' || !Number.isFinite(r['t'])) return false;
  if (r['type'] === 'start') return typeof r['app'] === 'string';
  if (typeof r['s'] !== 'string' || typeof r['a'] !== 'string') return false;
  switch (r['src']) {
    case 'hook':
      return r['h'] === 'busy' || r['h'] === 'awaiting' || r['h'] === 'idle';
    case 'det':
      return typeof r['st'] === 'string';
    case 'skip':
      return r['why'] === 'brain' || r['why'] === 'inexact-routing' || r['why'] === 'no-turn-start';
    default:
      return false;
  }
}

interface PendingRead {
  rec: DetectionDetectorRecord;
  cls: HookTruth;
  truthAtRead: HookTruth;
  deadline: number;
  counted: boolean;
}

interface PendingEdge {
  to: 'idle' | 'awaiting';
  t: number;
  deadline: number;
  s: string;
  a: string;
  counted: boolean;
}

interface PaneState {
  truth?: HookTruth;
  pendingReads: PendingRead[];
  pendingEdge?: PendingEdge;
}

function emptyStats(): AgentDetectionStats {
  return {
    reads: 0,
    hookEdges: 0,
    agree: 0,
    early: 0,
    falseIdle: 0,
    falseBusy: 0,
    falseAwaiting: 0,
    unconfirmedAwaiting: 0,
    hitIdle: 0,
    hitAwaiting: 0,
    missedIdle: 0,
    missedAwaiting: 0,
    leaked: 0,
    held: 0,
    noTruth: 0,
    provisionalStops: 0,
    offsetMs: { count: 0, led: 0, p50: null, p95: null },
    falseByRule: {},
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Judge every detector read and every hook edge in `records`.
 *
 * Read rules (hook truth H when the read was made, grace G):
 *   - read matches H → agree
 *   - read matches an idle/awaiting edge the hook made in the last G → agree,
 *     and that edge is a hit
 *   - running while H is awaiting → agree (output behind a dialog)
 *   - otherwise the read waits up to G for the hook to move to it (→ early);
 *     if the hook never does it is false_idle / false_busy / false_awaiting,
 *     except a dialog read while H was busy, which is unconfirmed_awaiting
 *     because ordinary approval prompts often have no hook at all.
 *
 * Edge rules: a hook edge into idle or awaiting is a hit when a detector read
 * of that class came within G either side of it; otherwise it is missed. A
 * state the hook left again within G is too short to miss: its edge is
 * dropped unjudged.
 *
 * A read or an edge is counted once its window settles. Windows still open at
 * the end of the log, or when a daemon restart (a start record) cuts them off,
 * are dropped unjudged: the matching record may simply not be written yet.
 */
export function analyzeDetectionRecords(
  records: readonly DetectionRecord[],
  opts: DetectionAnalysisOptions = {},
): DetectionReport {
  const graceMs = opts.graceMs ?? DEFAULT_DETECTION_GRACE_MS;
  const since = opts.since ?? Number.NEGATIVE_INFINITY;
  const sampleLimit = opts.sampleLimit ?? 20;

  const agents: Record<string, AgentDetectionStats> = {};
  const skippedSessions: Record<DetectionSkipReason, Set<string>> = {
    brain: new Set(),
    'inexact-routing': new Set(),
    'no-turn-start': new Set(),
  };
  const measuredSessions = new Set<string>();
  const apps: string[] = [];
  const samples: DetectionSample[] = [];
  const offsets = new Map<string, number[]>();
  const panes = new Map<string, PaneState>();
  let from: number | null = null;
  let to: number | null = null;

  const statsFor = (agent: string): AgentDetectionStats => {
    let st = agents[agent];
    if (!st) {
      st = emptyStats();
      agents[agent] = st;
    }
    return st;
  };
  const paneFor = (s: string, a: string): PaneState => {
    const key = `${s}\u0000${a}`;
    let p = panes.get(key);
    if (!p) {
      p = { pendingReads: [] };
      panes.set(key, p);
    }
    return p;
  };
  const noteTime = (t: number): void => {
    if (from === null || t < from) from = t;
    if (to === null || t > to) to = t;
  };
  const addSample = (sample: DetectionSample): void => {
    samples.push(sample);
    if (samples.length > sampleLimit) samples.shift();
  };
  const addOffset = (agent: string, detMinusHook: number): void => {
    let list = offsets.get(agent);
    if (!list) {
      list = [];
      offsets.set(agent, list);
    }
    list.push(detMinusHook);
  };

  const finalizeRead = (p: PendingRead): void => {
    if (!p.counted) return;
    const st = statsFor(p.rec.a);
    st.reads++;
    let outcome: DetectionOutcome;
    if (p.cls === 'idle') outcome = 'false_idle';
    else if (p.cls === 'busy') outcome = 'false_busy';
    else outcome = p.truthAtRead === 'busy' ? 'unconfirmed_awaiting' : 'false_awaiting';
    if (outcome === 'unconfirmed_awaiting') {
      st.unconfirmedAwaiting++;
      return;
    }
    if (outcome === 'false_idle') st.falseIdle++;
    else if (outcome === 'false_busy') st.falseBusy++;
    else st.falseAwaiting++;
    if (p.rec.d === 'pending') st.held++;
    else if (p.rec.d !== 'veto') st.leaked++;
    const rule = p.rec.r ?? '(none)';
    st.falseByRule[rule] = (st.falseByRule[rule] ?? 0) + 1;
    addSample({
      t: p.rec.t,
      s: p.rec.s,
      a: p.rec.a,
      outcome,
      read: p.rec.st,
      truth: p.truthAtRead,
      ...(p.rec.r !== undefined ? { rule: p.rec.r } : {}),
      ...(p.rec.d !== undefined ? { decision: p.rec.d } : {}),
    });
  };
  const finalizeEdge = (e: PendingEdge): void => {
    if (!e.counted) return;
    const st = statsFor(e.a);
    st.hookEdges++;
    const outcome: DetectionOutcome = e.to === 'idle' ? 'missed_idle' : 'missed_awaiting';
    if (e.to === 'idle') st.missedIdle++;
    else st.missedAwaiting++;
    addSample({ t: e.t, s: e.s, a: e.a, outcome });
  };
  const hit = (agent: string, to: 'idle' | 'awaiting', counted: boolean): void => {
    if (!counted) return;
    const st = statsFor(agent);
    st.hookEdges++;
    if (to === 'idle') st.hitIdle++;
    else st.hitAwaiting++;
  };
  // Settle everything on this pane whose window closed before `now`.
  const expire = (pane: PaneState, now: number): void => {
    if (pane.pendingReads.length > 0) {
      const keep: PendingRead[] = [];
      for (const p of pane.pendingReads) {
        if (now > p.deadline) finalizeRead(p);
        else keep.push(p);
      }
      pane.pendingReads = keep;
    }
    if (pane.pendingEdge && now > pane.pendingEdge.deadline) {
      finalizeEdge(pane.pendingEdge);
      pane.pendingEdge = undefined;
    }
  };

  // Stable sort by time: rotated files are concatenated oldest first, and a
  // flush can interleave lines from a buffered batch by a few ms.
  const ordered = records
    .map((rec, i) => ({ rec, i }))
    .sort((x, y) => x.rec.t - y.rec.t || x.i - y.i)
    .map((x) => x.rec);

  for (const rec of ordered) {
    if ('type' in rec) {
      if (rec.t >= since && apps[apps.length - 1] !== rec.app) apps.push(rec.app);
      // A daemon (re)start: the new process starts every pane over, and the
      // records that would have closed the old windows were never written.
      for (const pane of panes.values()) expire(pane, rec.t);
      panes.clear();
      continue;
    }
    const counted = rec.t >= since;
    if (rec.src === 'skip') {
      if (counted) skippedSessions[rec.why].add(rec.s);
      continue;
    }
    if (counted) noteTime(rec.t);
    const pane = paneFor(rec.s, rec.a);
    expire(pane, rec.t);

    if (rec.src === 'hook') {
      measuredSessions.add(rec.s);
      if (rec.pv) {
        if (counted) statsFor(rec.a).provisionalStops++;
        continue;
      }
      const prev = pane.truth;
      pane.truth = rec.h;
      if (prev === rec.h) continue;
      // Reads waiting for exactly this state were early, not wrong.
      let ledByRead = false;
      const keep: PendingRead[] = [];
      for (const p of pane.pendingReads) {
        if (p.cls === rec.h) {
          if (p.counted) {
            statsFor(rec.a).reads++;
            statsFor(rec.a).early++;
            addOffset(rec.a, p.rec.t - rec.t);
          }
          ledByRead = true;
        } else {
          keep.push(p);
        }
      }
      pane.pendingReads = keep;
      // Any transition ends the open edge. Its state lasted less than the
      // grace window (expire() above settles a longer one), too short to call
      // a miss, so it is dropped unjudged; a later read is judged against the
      // new state instead of following the old edge.
      pane.pendingEdge = undefined;
      if (prev === undefined || rec.h === 'busy') continue;
      if (ledByRead) {
        hit(rec.a, rec.h, counted);
      } else {
        pane.pendingEdge = { to: rec.h, t: rec.t, deadline: rec.t + graceMs, s: rec.s, a: rec.a, counted };
      }
      continue;
    }

    // Detector read.
    const cls = detectorReadClass(rec.st);
    if (cls === null) continue;
    if (pane.truth === undefined) {
      if (counted) statsFor(rec.a).noTruth++;
      continue;
    }
    const edge = pane.pendingEdge;
    if (edge && edge.to === cls) {
      // The hook got there first and the detector followed within the window.
      pane.pendingEdge = undefined;
      hit(rec.a, edge.to, edge.counted);
      if (edge.counted) addOffset(rec.a, rec.t - edge.t);
      if (counted) {
        statsFor(rec.a).reads++;
        statsFor(rec.a).agree++;
      }
      continue;
    }
    if (cls === pane.truth || (cls === 'busy' && pane.truth === 'awaiting')) {
      if (counted) {
        statsFor(rec.a).reads++;
        statsFor(rec.a).agree++;
      }
      continue;
    }
    pane.pendingReads.push({ rec, cls, truthAtRead: pane.truth, deadline: rec.t + graceMs, counted });
  }

  // End of the log: settle what closed before the last record; what is still
  // open may be waiting on a record the daemon has not flushed yet.
  const lastT = ordered.length > 0 ? ordered[ordered.length - 1].t : 0;
  for (const pane of panes.values()) expire(pane, lastT);

  for (const [agent, list] of offsets) {
    const st = statsFor(agent);
    const abs = list.map((v) => Math.abs(v)).sort((x, y) => x - y);
    st.offsetMs = {
      count: list.length,
      led: list.filter((v) => v < 0).length,
      p50: percentile(abs, 50),
      p95: percentile(abs, 95),
    };
  }

  const neverMeasured = (sessions: Set<string>): number =>
    [...sessions].filter((s) => !measuredSessions.has(s)).length;

  return {
    graceMs,
    from,
    to,
    apps,
    agents,
    skipped: {
      brain: neverMeasured(skippedSessions.brain),
      'inexact-routing': neverMeasured(skippedSessions['inexact-routing']),
      'no-turn-start': neverMeasured(skippedSessions['no-turn-start']),
    },
    samples,
  };
}
