// Pure pieces of the chat-v2 Codex driver: the `codex app-server` launch line,
// the version floor, and the mapping of app-server items and approval
// requests to chat-v2 previews, cards and replies. Written against the
// app-server v2 protocol of codex-cli 0.162.1 (generated JSON schema), where
// these behaviours were measured with a loopback model:
//   - `item/started` of a commandExecution or fileChange item comes before
//     its approval request, and the request's `itemId` is that item's id;
//   - the fileChange item carries the diff; its approval request does not;
//   - `decline` skips the tool and the turn goes on; `cancel` skips it and
//     interrupts the turn; a reply the server cannot parse skips the tool too.
import type { ToolPreview, ToolPreviewLine } from '../../../../shared/chatv2/session';
import { MAX_LINE_CHARS, MAX_PREVIEW_LINES } from '../../../../shared/chatv2/preview';
import type { UserQuestion } from '../../../../shared/chatv2/userQuestion';
import { TERMINAL_PROMPT_SUMMARY_MAX } from '../../../approvals/terminalPrompt';
import { asRecord } from '../claude/claudeProtocol';

/** The release whose approval semantics were measured. Anything older (or unreadable) is refused. */
export const CODEX_MIN_VERSION = '0.162.1';
/**
 * A config key Codex ignores, set on the launch line so the process carries
 * the chat's provider session id in its argv: the orphan sweep kills a driver
 * left by a previous daemon only when its command line holds that marker.
 */
export const CODEX_MARKER_KEY = 'wmux_chat_session';
/** Always explicit: a chat Codex never inherits an unattended mode from config. */
export const CODEX_APPROVAL_POLICY = 'on-request';
export const CODEX_SANDBOX = 'workspace-write';
/** What the terminal relay calls the reply that also ends the turn. */
export const CODEX_CANCEL_LABEL = 'No, stop the turn';

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function codexSpawnArgs(providerSessionId: string): string[] {
  return ['-c', `${CODEX_MARKER_KEY}="${providerSessionId}"`, 'app-server', '--listen', 'stdio://'];
}

/**
 * The version from the `initialize` response's userAgent, which names the
 * client first: `wmux_chat/0.162.1 (Mac OS 15.6.0; arm64) …`.
 */
export function codexVersionFromUserAgent(userAgent: unknown): string | null {
  const match = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(str(userAgent));
  return match ? match[1] : null;
}

/** True when `version` is at or above CODEX_MIN_VERSION. A pre-release of the floor predates it. */
export function codexVersionSupported(version: string | null): boolean {
  const parse = (text: string) => /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(text);
  const found = version ? parse(version) : null;
  const want = parse(CODEX_MIN_VERSION);
  if (!found || !want) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(found[i]) !== Number(want[i])) return Number(found[i]) > Number(want[i]);
  }
  return !found[4];
}

// --- file changes -------------------------------------------------------

export interface CodexFileChange {
  path: string;
  kind: 'add' | 'delete' | 'update';
  movePath?: string;
  diff: string;
}

export function fileChangesOf(value: unknown): CodexFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const change = asRecord(entry);
    const path = str(change?.path);
    if (!change || !path) return [];
    const kind = asRecord(change.kind);
    const type = str(kind?.type);
    const movePath = str(kind?.move_path);
    return [{
      path,
      kind: type === 'add' || type === 'delete' ? type : 'update',
      ...(movePath ? { movePath } : {}),
      diff: str(change.diff),
    }];
  });
}

function textLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function capLine(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

/**
 * Lines and counts of one change. An add carries the new file's text, a
 * delete the removed one, and an update a unified diff (hunks, maybe headers).
 */
export function changeLines(change: CodexFileChange): { lines: ToolPreviewLine[]; additions: number; deletions: number } {
  if (change.kind !== 'update') {
    const kind = change.kind === 'add' ? 'add' : 'del';
    const all = textLines(change.diff);
    return {
      lines: all.slice(0, MAX_PREVIEW_LINES).map((text, index) => ({ number: index + 1, kind, text: capLine(text) })),
      additions: kind === 'add' ? all.length : 0,
      deletions: kind === 'del' ? all.length : 0,
    };
  }
  const lines: ToolPreviewLine[] = [];
  let additions = 0;
  let deletions = 0;
  let next = 0;
  for (const line of textLines(change.diff)) {
    const header = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(line);
    if (header) { next = Number(header[1]); continue; }
    if (/^(diff |index |--- |\+\+\+ |\\)/.test(line)) continue;
    if (line.startsWith('+')) { additions += 1; lines.push({ number: next, kind: 'add', text: line.slice(1) }); next += 1; }
    else if (line.startsWith('-')) { deletions += 1; lines.push({ number: next, kind: 'del', text: line.slice(1) }); }
    else { lines.push({ number: next, kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line }); next += 1; }
  }
  // Open on the first changed line, with one line of context above it.
  const first = lines.findIndex((line) => line.kind !== 'context');
  const from = Math.max(0, first - 1);
  return {
    lines: lines.slice(from, from + MAX_PREVIEW_LINES).map((line) => ({ ...line, text: capLine(line.text) })),
    additions,
    deletions,
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The row preview of a fileChange item: the first file's diff, counts over every file. */
export function fileChangePreview(changes: CodexFileChange[]): ToolPreview | undefined {
  const first = changes[0];
  if (!first) return undefined;
  const all = changes.map(changeLines);
  const path = first.movePath ?? first.path;
  return {
    kind: 'write',
    title: changeTitle(changes),
    path,
    fileName: baseName(path),
    additions: all.reduce((sum, c) => sum + c.additions, 0),
    deletions: all.reduce((sum, c) => sum + c.deletions, 0),
    lines: all[0].lines,
  };
}

export function changeTitle(changes: CodexFileChange[]): string {
  if (changes.length !== 1) return `Edit ${changes.length} files`;
  const change = changes[0];
  const verb = change.kind === 'add' ? 'Create' : change.kind === 'delete' ? 'Delete' : 'Edit';
  return `${verb} ${baseName(change.movePath ?? change.path)}`;
}

/** One card line: every path with its counts, e.g. `src/a.ts +3 −1, b.ts +2 −0`. */
export function changeSummary(changes: CodexFileChange[]): string {
  return changes.map((change) => {
    const { additions, deletions } = changeLines(change);
    const path = change.movePath ? `${change.path} → ${change.movePath}` : change.path;
    return `${path} +${additions} −${deletions}`;
  }).join(', ');
}

/** A content fingerprint of a change set: a card shown for one diff must not approve another. */
export function changesKey(changes: CodexFileChange[]): string {
  return JSON.stringify(changes.map((c) => [c.path, c.kind, c.movePath ?? '', c.diff]));
}

// --- approvals ----------------------------------------------------------

/**
 * What Deny sends. `decline` skips the call and lets the agent go on, like a
 * Claude deny. When the request lists the decisions it takes and `decline` is
 * not among them, `cancel`: it skips the call and stops the turn. Never accept.
 */
export function denyDecision(availableDecisions: unknown): 'decline' | 'cancel' {
  if (!Array.isArray(availableDecisions)) return 'decline';
  return availableDecisions.includes('decline') ? 'decline' : 'cancel';
}

/** The command approval's card line. */
export function commandSummary(params: Record<string, unknown>): string {
  const network = asRecord(params.networkApprovalContext);
  if (network) return `Network access to ${str(network.host) || 'a host'} (${str(network.protocol) || 'unknown'})`;
  if (str(params.kind) === 'writeStdin') return `Send input to a running command${str(params.command) ? `: ${str(params.command)}` : ''}`;
  return str(params.command) || str(params.reason) || 'Run a command';
}

// --- permissions requests -------------------------------------------------

const FILE_SYSTEM_KEYS = new Set(['read', 'write', 'entries', 'globScanMaxDepth']);
const NETWORK_KEYS = new Set(['enabled']);
const PROFILE_KEYS = new Set(['fileSystem', 'network']);

export type PermissionsCard =
  | { ok: true; summary: string; grant: Record<string, unknown> }
  | { ok: false; reason: string };

function entryLine(entry: unknown): string | null {
  const rec = asRecord(entry);
  const path = asRecord(rec?.path);
  const access = str(rec?.access);
  if (!rec || !path || !access) return null;
  const type = str(path.type);
  const target = type === 'path' ? str(path.path)
    : type === 'glob_pattern' ? str(path.pattern)
    : type === 'special' ? `(${str(asRecord(path.value)?.kind) || 'special'})`
    : '';
  return target ? `${access} ${target}` : null;
}

function stringList(value: unknown): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) return null;
  return value as string[];
}

/**
 * The card for `item/permissions/requestApproval`: only keys this driver can
 * show are granted, an unknown key refuses the request, and a profile whose
 * line would be cut on the card is refused, since the human must see every
 * path before allowing it.
 */
export function permissionsCard(permissions: unknown): PermissionsCard {
  const profile = asRecord(permissions);
  if (!profile) return { ok: false, reason: 'no permission profile' };
  const unknown = Object.keys(profile).filter((k) => !PROFILE_KEYS.has(k) && profile[k] != null);
  const fileSystem = profile.fileSystem == null ? null : asRecord(profile.fileSystem);
  const network = profile.network == null ? null : asRecord(profile.network);
  if ((profile.fileSystem != null && !fileSystem) || (profile.network != null && !network)) return { ok: false, reason: 'unreadable permission profile' };
  if (fileSystem) unknown.push(...Object.keys(fileSystem).filter((k) => !FILE_SYSTEM_KEYS.has(k) && fileSystem[k] != null).map((k) => `fileSystem.${k}`));
  if (network) unknown.push(...Object.keys(network).filter((k) => !NETWORK_KEYS.has(k) && network[k] != null).map((k) => `network.${k}`));
  if (unknown.length) return { ok: false, reason: `unknown permission ${unknown.join(', ')}` };

  const parts: string[] = [];
  const grant: Record<string, unknown> = {};
  if (fileSystem) {
    const read = stringList(fileSystem.read);
    const write = stringList(fileSystem.write);
    const rawEntries = fileSystem.entries == null ? [] : fileSystem.entries;
    if (!read || !write || !Array.isArray(rawEntries)) return { ok: false, reason: 'unreadable file system permission' };
    const entries = rawEntries.map(entryLine);
    if (entries.some((line) => line === null)) return { ok: false, reason: 'unreadable file system entry' };
    if (write.length) parts.push(`write ${write.join(', ')}`);
    if (read.length) parts.push(`read ${read.join(', ')}`);
    parts.push(...entries as string[]);
    const granted: Record<string, unknown> = {};
    if (write.length) granted.write = write;
    if (read.length) granted.read = read;
    if (rawEntries.length) granted.entries = rawEntries;
    if (typeof fileSystem.globScanMaxDepth === 'number') granted.globScanMaxDepth = fileSystem.globScanMaxDepth;
    if (Object.keys(granted).length) grant.fileSystem = granted;
  }
  if (network && typeof network.enabled === 'boolean') {
    parts.push(network.enabled ? 'network on' : 'network off');
    grant.network = { enabled: network.enabled };
  }
  if (!parts.length) return { ok: false, reason: 'empty permission profile' };
  const summary = parts.join('; ');
  if (summary.length > TERMINAL_PROMPT_SUMMARY_MAX) return { ok: false, reason: 'permission profile too long to show in full' };
  return { ok: true, summary, grant };
}

// --- request_user_input ---------------------------------------------------

export interface CodexQuestionSet {
  /** As the transcript and the form key them (`q0…`, options `1…`). */
  questions: UserQuestion[];
  /** Codex's own question id and option labels, by index. */
  native: Array<{ id: string; labels: string[] }>;
}

/** Null when a question cannot be asked here (unreadable, or a secret the transcript would keep). */
export function codexQuestions(value: unknown): CodexQuestionSet | null {
  if (!Array.isArray(value) || !value.length) return null;
  const questions: UserQuestion[] = [];
  const native: CodexQuestionSet['native'] = [];
  for (const [index, entry] of value.entries()) {
    const q = asRecord(entry);
    const id = str(q?.id);
    const prompt = str(q?.question);
    if (!q || !id || !prompt || q.isSecret === true) return null;
    const options = Array.isArray(q.options) ? q.options.flatMap((o) => {
      const option = asRecord(o);
      const label = str(option?.label);
      return label ? [{ label, description: str(option?.description) }] : [];
    }) : [];
    questions.push({
      id: `q${index}`,
      ...(str(q.header) ? { header: str(q.header) } : {}),
      prompt,
      multiSelect: false,
      allowCustom: q.isOther === true || options.length === 0,
      options: options.map((option, i) => ({ id: String(i + 1), label: option.label, ...(option.description ? { description: option.description } : {}) })),
    });
    native.push({ id, labels: options.map((option) => option.label) });
  }
  return { questions, native };
}
