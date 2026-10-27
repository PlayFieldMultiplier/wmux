// Browser help requests on the phone (contract: shared/phoneBrowserHelp.ts):
//
//   GET  /api/browser-help
//   POST /api/browser-help/:requestId/decision   {outcome}
//
// The list is served from the table main published (phone/BrowserHelpTable.ts)
// with no desktop round trip. It carries the agent-written prompt, so it needs
// the transcript consent; any authenticated caller (the operator token, or a
// paired device that is not revoked) reads it.
//
// A decision needs the transcript consent too, and is taken from the operator
// token or from a paired device that holds the input grant AND had it set
// explicitly, the rule of bot approvals; a server started without
// --allow-input takes none. These are checked before the body is read, and
// again on the credential presented once the body is in. The workspace is the
// one the table holds for the id, never one the phone sent. Main settles it
// (`workspaces.browserHelpDecide`, first answer wins) and its error codes come
// back inside a successful reply. Nothing here retries a decision. A decision
// main took closes the row here at once, ahead of main's next table.

import {
  BROWSER_HELP_CAPABILITY,
  PHONE_BROWSER_HELP_DECIDE_COMMAND,
  isBrowserHelpId,
  parseBrowserHelpDecideBody,
  parseBrowserHelpDecideReply,
  type BrowserHelpErrorCode,
  type BrowserHelpTableRow,
  type PhoneBrowserHelpRow,
} from '../../shared/phoneBrowserHelp';
import type { BrowserHelpOutcome } from '../../shared/browserHelp';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';
import { GRANT_HINT, type BotApprovalsCaller, type BotApprovalsDesktop, type BotApprovalsResponse } from './botApprovals';
import type { BrowserHelpLookup } from '../phone/BrowserHelpTable';

export const BROWSER_HELP_LIST_ROUTE = '/api/browser-help';
export const BROWSER_HELP_DECISION_ROUTE = /^\/api\/browser-help\/([^/]+)\/decision$/;

/** The part of the daemon's table the routes use (BrowserHelpTable). */
export interface BrowserHelpTableView {
  readonly published: boolean;
  list(): BrowserHelpTableRow[];
  lookup(requestId: string): BrowserHelpLookup;
  closeDecided(requestId: string, state: BrowserHelpOutcome): void;
}

const ERROR_STATUS: Record<BrowserHelpErrorCode, number> = {
  'browser-help-not-found': 404,
  'browser-help-closed': 409,
};

/** `/api/config` `browserHelp`: the transcript consent, and a desktop that announced the table. */
export function browserHelpSupported(desktop: BotApprovalsDesktop | null, allowTranscript: boolean): boolean {
  return allowTranscript && !!desktop && desktop.supports(BROWSER_HELP_CAPABILITY);
}

/** Whether a row came from a brain pane's agent (`isBrainPty` over the live session). */
export type BrainPaneCheck = (ptyId: string) => boolean;

/** Whether `/api/sessions` lists this pane (a live pane that is not a brain's). */
export type ListedSessionCheck = (ptyId: string) => boolean;

/**
 * The row a phone is served: never the raw requesting pane; a brain pane's
 * never previewable. `sessionId` names the requesting pane only as
 * `/api/sessions` does, and only when that list has it: a brain pane, a pane
 * gone since, or no requester at all leaves it out.
 */
function phoneRow(row: BrowserHelpTableRow, isBrainPane: BrainPaneCheck, listed: ListedSessionCheck): PhoneBrowserHelpRow {
  const { requesterPtyId, ...served } = row;
  if (requesterPtyId === undefined) return served;
  if (isBrainPane(requesterPtyId)) return { ...served, previewable: false };
  return listed(requesterPtyId) ? { ...served, sessionId: requesterPtyId } : served;
}

/** `GET /api/browser-help`. */
export function browserHelpListResponse(opts: {
  allowTranscript: boolean;
  desktop: BotApprovalsDesktop | null;
  table: BrowserHelpTableView | null;
  isBrainPane: BrainPaneCheck;
  /** Absent: no row carries `sessionId`. */
  listedSession?: ListedSessionCheck;
}): BotApprovalsResponse {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'browser-help-disabled' } };
  // No table yet is not an empty table: say the desktop is not there.
  if (!browserHelpSupported(opts.desktop, true) || !opts.table?.published) {
    return { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const listed = opts.listedSession ?? (() => false);
  return { status: 200, body: { requests: opts.table.list().map((row) => phoneRow(row, opts.isBrainPane, listed)) } };
}

/** Why this caller may not decide, or null when it may. */
export function browserHelpDecisionRefusal(caller: BotApprovalsCaller, opts: { readOnly: boolean; allowTranscript: boolean }): BotApprovalsResponse | null {
  if (!opts.allowTranscript) return { status: 403, body: { error: 'browser-help-disabled' } };
  if (opts.readOnly) return { status: 403, body: { error: 'read-only' } };
  if (caller.kind === 'operator') return null;
  if (!caller.mayInput) {
    return { status: 403, body: { error: 'read-only: this device was paired without permission to type', detail: `Answering a browser help request requires input permission. ${GRANT_HINT}` } };
  }
  if (!caller.explicitInputGrant) {
    return { status: 403, body: { error: 'read-only: this device has no explicit input grant', detail: `Answering a browser help request needs an input grant set for this device. ${GRANT_HINT}` } };
  }
  return null;
}

/** `POST /api/browser-help/:requestId/decision` (the parsed JSON body). Never throws. */
export async function browserHelpDecisionResponse(
  rawId: string,
  body: unknown,
  opts: {
    caller: BotApprovalsCaller;
    desktop: BotApprovalsDesktop | null;
    table: BrowserHelpTableView | null;
    readOnly: boolean;
    allowTranscript: boolean;
    isBrainPane: BrainPaneCheck;
    /** The caller the credential on this request resolves to now, or null
     *  when it no longer authenticates as the same caller. Missing: refused. */
    reauthorize?: () => Promise<BotApprovalsCaller | null>;
  },
): Promise<BotApprovalsResponse> {
  const gates = { readOnly: opts.readOnly, allowTranscript: opts.allowTranscript };
  const refused = browserHelpDecisionRefusal(opts.caller, gates);
  if (refused) return refused;
  const decided = parseBrowserHelpDecideBody(body);
  if (!decided) return { status: 400, body: { error: 'invalid-decision' } };
  // The credential that sent the headers, checked again now the body is in:
  // the same caller (the same device), still allowed to decide.
  let now: BotApprovalsCaller | null = null;
  try {
    now = opts.reauthorize ? await opts.reauthorize() : null;
  } catch {
    now = null;
  }
  if (!now || !sameCaller(opts.caller, now)) return { status: 401, body: { error: 'authorization-expired' } };
  const again = browserHelpDecisionRefusal(now, gates);
  if (again) return again;
  let requestId: string;
  try {
    requestId = decodeURIComponent(rawId);
  } catch {
    return { status: 404, body: { error: 'browser-help-not-found' } };
  }
  if (!isBrowserHelpId(requestId)) return { status: 404, body: { error: 'browser-help-not-found' } };
  const desktop = opts.desktop;
  if (!desktop || !opts.table?.published || !desktop.supports(PHONE_BROWSER_HELP_DECIDE_COMMAND)) {
    return { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const found = opts.table.lookup(requestId);
  if (!found) return { status: 404, body: { error: 'browser-help-not-found' } };
  if ('closed' in found) return { status: 409, body: { error: 'browser-help-closed' } };
  // A brain pane's request is answered at the desktop, as its approvals are.
  const requester = found.row.requesterPtyId;
  if (now.kind === 'device' && requester !== undefined && opts.isBrainPane(requester)) {
    return { status: 403, body: { error: 'browser-help-disabled' } };
  }
  let raw: unknown;
  try {
    raw = await desktop.request(PHONE_BROWSER_HELP_DECIDE_COMMAND, {
      requestId,
      workspaceId: found.row.workspaceId,
      outcome: decided.outcome,
    });
  } catch (error) {
    // Not retried: the request may have been settled before the reply was
    // lost. The phone reads the list again to learn how it ended.
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const reply = parseBrowserHelpDecideReply(raw);
  if (!reply) return { status: 502, body: { error: 'desktop-bad-reply' } };
  if ('unavailable' in reply) return { status: 503, body: { error: 'desktop-unavailable' } };
  if ('invalid' in reply) return { status: 400, body: { error: 'invalid-decision' } };
  if ('error' in reply) return { status: ERROR_STATUS[reply.error], body: { error: reply.error } };
  // Closed here at once, so the list read right after this reply agrees.
  opts.table.closeDecided(requestId, reply.state);
  return { status: 200, body: { requestId, state: reply.state } };
}

function sameCaller(original: BotApprovalsCaller, now: BotApprovalsCaller): boolean {
  return now.kind === 'operator'
    ? original.kind === 'operator'
    : original.kind === 'device' && now.deviceId === original.deviceId;
}
