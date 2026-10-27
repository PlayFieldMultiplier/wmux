// A tool call Claude Code refused, as its own transcript records it: the
// line it writes with each tool result carries the permission decision
// (`permissionDecision`), and a Bash command's sandbox violations
// (`sandboxViolations`). The same facts its `claude_code.safety_event`
// OpenTelemetry event carries, read with no exporter set up.
//
// Those are not a documented format. Every field is checked, and a line
// whose fields are missing or of another shape says nothing: it is never
// read as a refusal.
//
// What it does not see: a macOS sandbox refusal of a file write (Claude Code
// records none for it, only the command's own error), and a permission
// prompt still waiting for its answer (that is the pane's awaiting-input
// state, not a refusal).

/** What refused the call. */
export type ToolRefusalKind =
  /** A permission deny rule (settings, a managed policy). */
  | 'rule'
  /** A hook refused it (a PreToolUse hook's exit 2: the worker fence's hook among them). */
  | 'hook'
  /** Auto mode's classifier refused it, or could not decide. */
  | 'auto-mode'
  /** The permission mode refused it (no prompt can be shown). */
  | 'mode'
  /** The person refused it at the prompt. */
  | 'user'
  /** It ran, and the sandbox refused a connection it made. */
  | 'sandbox-network'
  | 'other';

export interface ToolRefusal {
  toolUseId: string;
  kind: ToolRefusalKind;
  /** Claude Code's own name for who decided (`config`, `hook`, …). */
  source: string;
  /** Claude Code's reason code (`rule:userSettings`, `hook:PreToolUse`, …), or null. */
  reasonCode: string | null;
  /** When the result was written (ms). */
  at: number;
}

/** What one transcript line says about the turn's tool calls. */
export type TranscriptToolOutcome =
  | { type: 'refused'; refusal: ToolRefusal }
  /** A tool result with nothing refused. */
  | { type: 'accepted' }
  /** The person's next prompt. */
  | { type: 'prompt' }
  /** A tool result it cannot read a decision from: the format may have
   *  changed (`version` names the writer), or the line holds several results. */
  | { type: 'unknown'; version: string | null };

const KINDS: ReadonlySet<string> = new Set<ToolRefusalKind>(['rule', 'hook', 'auto-mode', 'mode', 'user', 'sandbox-network', 'other']);
const WORD_RE = /^[\x21-\x7e]{1,128}$/;
const INTERRUPTED_PREFIX = '[Request interrupted by user';

function word(v: unknown, max = 128): string | null {
  return typeof v === 'string' && v.length <= max && WORD_RE.test(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kindOf(decision: Record<string, unknown>): ToolRefusalKind {
  const source = typeof decision.source === 'string' ? decision.source : '';
  const reasonType = typeof decision.reasonType === 'string' ? decision.reasonType : '';
  const code = typeof decision.reasonCode === 'string' ? decision.reasonCode : '';
  if (source === 'hook' || reasonType === 'hook' || code.startsWith('hook:')) return 'hook';
  if (reasonType === 'classifier' || code.startsWith('classifier')) return 'auto-mode';
  if (source.startsWith('user')) return 'user';
  if (code.startsWith('rule:')) return 'rule';
  if (reasonType === 'mode' || code.startsWith('mode')) return 'mode';
  return 'other';
}

/** One Claude Code transcript line, or null when it says nothing about tool calls. Pure. */
export function toolOutcomeOfLine(line: string, now: number = Date.now()): TranscriptToolOutcome | null {
  if (!line.includes('"type":"user"')) return null;
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(j) || j.type !== 'user' || j.isMeta === true || j.isSidechain === true || j.isCompactSummary === true) return null;
  const message = isRecord(j.message) ? j.message : null;
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') return { type: 'prompt' };
  if (!Array.isArray(content)) return null;
  const results = content.filter((c): c is Record<string, unknown> => isRecord(c) && c.type === 'tool_result');
  if (results.length === 0) {
    // Claude Code's own note after the person refused at the prompt is no prompt.
    const texts = content.filter((c): c is Record<string, unknown> => isRecord(c) && c.type === 'text');
    return texts.length > 0 && !texts.every((t) => typeof t.text === 'string' && t.text.startsWith(INTERRUPTED_PREFIX)) ? { type: 'prompt' } : null;
  }
  // One decision per line: with several results it belongs to none of them.
  if (results.length > 1) return { type: 'unknown', version: null };
  const result = results[0];
  const decision = j.permissionDecision;
  const toolUseId = word(result.tool_use_id);
  if (!isRecord(decision) || typeof decision.decision !== 'string' || !toolUseId) {
    return { type: 'unknown', version: word(j.version, 32) };
  }
  const at = typeof j.timestamp === 'string' && Number.isFinite(Date.parse(j.timestamp)) ? Date.parse(j.timestamp) : now;
  const source = word(decision.source, 64) ?? 'other';
  if (decision.decision === 'reject') {
    return { type: 'refused', refusal: { toolUseId, kind: kindOf(decision), source, reasonCode: word(decision.reasonCode), at } };
  }
  const violations = Array.isArray(j.sandboxViolations) ? j.sandboxViolations : [];
  if (decision.decision === 'accept' && violations.some((v) => isRecord(v) && v.kind === 'network')) {
    return { type: 'refused', refusal: { toolUseId, kind: 'sandbox-network', source: 'sandbox', reasonCode: null, at } };
  }
  return { type: 'accepted' };
}

/** A refusal as it crosses a process boundary, or null when it is not one. Pure. */
export function parseToolRefusal(raw: unknown): ToolRefusal | null {
  if (!isRecord(raw)) return null;
  const toolUseId = word(raw.toolUseId);
  const source = word(raw.source, 64);
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind as ToolRefusalKind : null;
  const reasonCode = raw.reasonCode === null ? null : word(raw.reasonCode);
  if (!toolUseId || !source || !kind) return null;
  if (raw.reasonCode !== null && reasonCode === null) return null;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) return null;
  return { toolUseId, kind, source, reasonCode, at: raw.at };
}

const KIND_WORDS: Readonly<Record<ToolRefusalKind, string>> = {
  rule: 'a permission rule',
  hook: 'a hook',
  'auto-mode': 'auto mode',
  mode: 'the permission mode',
  user: 'the person',
  'sandbox-network': 'the sandbox',
  other: 'a safety check',
};

/** One line for a turn that ended on it, e.g. "stopped after a refused tool call (a hook)". Pure. */
export function refusalStopLine(r: Pick<ToolRefusal, 'kind'>): string {
  return r.kind === 'sandbox-network'
    ? 'stopped after the sandbox refused a network connection'
    : `stopped after a refused tool call (${KIND_WORDS[r.kind]})`;
}
