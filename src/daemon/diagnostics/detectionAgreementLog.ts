/**
 * Detection agreement log — the daemon half of the screen-detector accuracy
 * measurement (analysis: shared/detectionAgreement.ts, report:
 * `wmux doctor detect --stats`).
 *
 * The hook and the detector meet in this process: hook events go out through
 * HookIngest's `emitAgentEvent`, detector reads through the `session:agent`
 * handler after `arbitrateDetector`. This class sits at both points and writes
 * raw TRANSITIONS only. It judges nothing and changes nothing: the analysis
 * runs offline, so its rules and grace window can change without collecting
 * the data again.
 *
 * Only panes whose hook can serve as ground truth are recorded:
 *   - the bridge's authority was routed by exact ptyId (a cwd-prefix fallback
 *     can land on a neighbouring pane, #919);
 *   - the pane has delivered a turn start (`agent.user_prompt_submit`) for this
 *     agent — without one, the idle a Stop leaves behind would stand for the
 *     whole next turn;
 *   - the detector names the same agent the bridge speaks for;
 *   - it is not a deck brain pty.
 * Everything else leaves at most one `skip` line per pane and reason.
 *
 * Off unless `diagnostics.detectionAgreement` is true in the daemon config.
 * Local file only; nothing here leaves the machine. The rule label is the
 * detector message, which can carry a few words of screen text, so it is
 * stripped of control characters, credentials masked (shared/redactSecrets.ts)
 * and cut short.
 *
 * Best-effort throughout: a failure here must never disturb detection.
 */
import { redactSecrets } from '../../shared/redactSecrets';
import { agentDisplayToSlug } from '../../shared/agentIdentity';
import {
  DETECTION_LOG_VERSION,
  hookTruthFor,
  type DetectionRecord,
  type DetectionSkipReason,
  type HookTruth,
} from '../../shared/detectionAgreement';

/** Longest rule label kept from a detector message. */
export const MAX_RULE_LABEL_CHARS = 60;

/**
 * How far a hook's own timestamp may sit behind the daemon clock and still be
 * used. A stop or awaiting_input is broadcast only after CompletionAlarm's hold,
 * so the receive time is late; a spooled or clock-skewed (WSL) stamp is not
 * trusted.
 */
const MAX_HOOK_STAMP_LAG_MS = 60_000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export interface DetectionAgreementLogDeps {
  /** Append one NDJSON line (newline included). Must not throw into the caller. */
  write: (line: string) => void;
  /** The pane's live hook authority, as HookIngest.authorityAgentFor reports it. */
  authorityFor: (sessionId: string) => { slug: string; exact: boolean } | undefined;
  isBrain: (sessionId: string) => boolean;
  /** App version that spawned the daemon, for the start record. */
  app: string;
  os: string;
  now?: () => number;
}

/** The part of a hook `agent.event` payload the log reads. */
export interface HookEventLike {
  status: string;
  /** What the broadcast reports; differs from `signal.kind` for the PreToolUse gate. */
  hookKind?: string;
  signal: { kind: string; agent: string; ts?: number };
}

/** The part of a detector `agent.event` payload the log reads. */
export interface DetectorEventLike {
  /** Display name ("Claude Code"). */
  agent: string;
  status: string;
  message?: string;
}

interface PaneTrust {
  agent: string;
  turnStartSeen: boolean;
  truth?: HookTruth;
  /** When the truth last turned busy; a transcript end before it is the previous turn's. */
  busySince?: number;
  skipped: Set<DetectionSkipReason>;
}

export class DetectionAgreementLog {
  private readonly panes = new Map<string, PaneTrust>();
  private readonly now: () => number;

  constructor(private readonly deps: DetectionAgreementLogDeps) {
    this.now = deps.now ?? Date.now;
    this.emit({ v: DETECTION_LOG_VERSION, type: 'start', t: this.now(), app: deps.app, os: deps.os });
  }

  /**
   * A hook event is about to be broadcast. `provisionalStop` marks a Codex
   * stop the transcript has not confirmed yet: recorded, never used as truth.
   */
  noteHook(sessionId: string, data: HookEventLike, opts: { provisionalStop?: boolean } = {}): void {
    try {
      const slug = data.signal.agent;
      const kind = data.hookKind ?? data.signal.kind;
      const t = this.hookTime(data.signal.ts);
      const pane = this.paneFor(sessionId, slug);
      if (this.deps.isBrain(sessionId)) {
        this.skipOnce(pane, sessionId, 'brain', t);
        return;
      }
      if (!this.governedExactly(sessionId, slug)) {
        this.skipOnce(pane, sessionId, 'inexact-routing', t);
        return;
      }
      if (kind === 'agent.user_prompt_submit') pane.turnStartSeen = true;
      if (!pane.turnStartSeen) {
        this.skipOnce(pane, sessionId, 'no-turn-start', t);
        return;
      }
      const truth = hookTruthFor(kind, data.status);
      if (truth === null) return;
      if (opts.provisionalStop && truth === 'idle') {
        this.emit({ v: DETECTION_LOG_VERSION, t, s: sessionId, a: slug, src: 'hook', h: 'idle', k: kind, pv: true });
        return;
      }
      this.transition(pane, sessionId, truth, kind, t);
    } catch {
      // Diagnostics must never disturb the hook path.
    }
  }

  /**
   * The transcript recorded a turn end at `at`. An interrupt (Esc, a rejected
   * tool) fires no Stop hook, and a Codex stop waits for its rollout to
   * confirm it; this is the only signal the turn is over in both cases.
   */
  noteTurnEnd(sessionId: string, at: number): void {
    try {
      const pane = this.panes.get(sessionId);
      if (!pane || !pane.turnStartSeen || pane.truth === undefined || pane.truth === 'idle') return;
      if (pane.busySince === undefined || at < pane.busySince || at > this.now()) return;
      if (!this.governedExactly(sessionId, pane.agent)) return;
      this.transition(pane, sessionId, 'idle', 'transcript.turn_end', at);
    } catch {
      // Diagnostics must never disturb the transcript path.
    }
  }

  /** A detector read was arbitrated. `decision` is the daemon's stamp, if any. */
  noteDetector(sessionId: string, event: DetectorEventLike, decision?: string): void {
    try {
      const slug = agentDisplayToSlug(event.agent);
      if (!slug) return;
      const pane = this.panes.get(sessionId);
      // No truth to judge against: an untrusted pane, or another agent's read.
      if (!pane || pane.agent !== slug || !pane.turnStartSeen || pane.truth === undefined) return;
      if (!this.governedExactly(sessionId, slug)) return;
      const rule = ruleLabel(event.message);
      this.emit({
        v: DETECTION_LOG_VERSION,
        t: this.now(),
        s: sessionId,
        a: slug,
        src: 'det',
        st: event.status,
        ...(decision !== undefined ? { d: decision } : {}),
        ...(rule ? { r: rule } : {}),
      });
    } catch {
      // Diagnostics must never disturb the detector path.
    }
  }

  /** Forget a pane that died or was destroyed. */
  dropSession(sessionId: string): void {
    this.panes.delete(sessionId);
  }

  // Transitions only: a tool-heavy turn sends dozens of busy signals.
  private transition(pane: PaneTrust, sessionId: string, truth: HookTruth, kind: string, t: number): void {
    if (truth === pane.truth) return;
    pane.truth = truth;
    if (truth === 'busy') pane.busySince = t;
    this.emit({ v: DETECTION_LOG_VERSION, t, s: sessionId, a: pane.agent, src: 'hook', h: truth, k: kind });
  }

  private hookTime(stamp: number | undefined): number {
    const now = this.now();
    if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return now;
    const lag = now - stamp;
    return lag >= 0 && lag <= MAX_HOOK_STAMP_LAG_MS ? stamp : now;
  }

  private governedExactly(sessionId: string, slug: string): boolean {
    const auth = this.deps.authorityFor(sessionId);
    return auth !== undefined && auth.exact && auth.slug === slug;
  }

  /** The pane's trust state for `agent`; a different agent starts over. */
  private paneFor(sessionId: string, agent: string): PaneTrust {
    let pane = this.panes.get(sessionId);
    if (!pane || pane.agent !== agent) {
      pane = { agent, turnStartSeen: false, skipped: new Set() };
      this.panes.set(sessionId, pane);
    }
    return pane;
  }

  private skipOnce(pane: PaneTrust, sessionId: string, why: DetectionSkipReason, t: number): void {
    if (pane.skipped.has(why)) return;
    pane.skipped.add(why);
    this.emit({ v: DETECTION_LOG_VERSION, t, s: sessionId, a: pane.agent, src: 'skip', why });
  }

  private emit(record: DetectionRecord): void {
    try {
      this.deps.write(`${JSON.stringify(record)}\n`);
    } catch {
      // A full disk or a closed file must not reach the caller.
    }
  }
}

function ruleLabel(message: string | undefined): string | undefined {
  if (!message) return undefined;
  // Redacted BEFORE the cut, so a key is never left half-visible at the end.
  const clean = redactSecrets(message.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim());
  if (!clean) return undefined;
  return clean.length > MAX_RULE_LABEL_CHARS ? clean.slice(0, MAX_RULE_LABEL_CHARS) : clean;
}
