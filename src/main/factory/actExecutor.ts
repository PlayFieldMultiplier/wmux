// ─── The act executor — runs the acts the owner approved ───────────────────
//
// One try of an approved act (a comment, a new issue, closing an issue or a
// PR), from its row in the act outbox (actEffectStore.ts), under the same
// gates the merge executor puts a merge through:
//
//   reconcile   a row that may have run (uncertain, or pending after an
//               earlier try) is read on GitHub first — by the marker in the
//               body, or the target's state and who closed it — and nothing
//               is sent while that read cannot say;
//   claim       journaled inFlight before anything is sent;
//   authorize   the approval store: the request is approved now, by the
//               owner, with the same payload, its Undo window over, its bot
//               still there on the same repository. Taken back (Undo) or
//               not due: the row returns to pending, nothing written;
//   identity    the gh login is the one the request recorded;
//   pins        the repository still answers as the full name, node id and
//               numeric id the request read (writes go to `repos/<owner>/
//               <repo>`: GitHub's `repositories/<id>` paths answer reads but
//               are undocumented, so no write goes through them), the target
//               is the same node, open, and on
//               a PR still at the head the card showed;
//   late gate   authorize again, right before the write;
//   write       gh api with a JSON body main built (GhActService.ts); the
//               answer must be what the act makes (a comment by the owner's
//               login holding the marker, …), else the try is uncertain.
//
// GitHub's 4xx is a refusal (nothing was written); a rate limit or a gh that
// did not start gives the try back; anything else is uncertain and settled
// by a read no sooner than RECONCILE_AFTER_MS later. A refusal is final for
// its request: the bot asks again with a new request.

import { splitRepoKey } from '../github/GhIssueService';
import type { GhActAnswer, GhActPort } from '../github/GhActService';
import type { ApprovalAct, ApprovalActRepo } from '../../shared/botApproval';
import { actMarker, bodyWithMarker, normalizeActText } from './actPayload';
import { actRowClaimed, runnableAct, type ActEffect, type ActEffectStore } from './actEffectStore';
import type { StoredApproval } from './approvals';

/** How long an uncertain try waits before a read settles it. */
export const RECONCILE_AFTER_MS = 60_000;

/** Pages of 100 a reconcile reads at most; a longer listing cannot say. */
const LIST_PAGES_MAX = 10;

/** Authorize answers that mean "not now", not "never": the row waits
 *  (the approval taken back or not due, the store or the bot directory not
 *  readable during a start or a quit). */
export const ACT_NOT_NOW: ReadonlySet<string> = new Set(['approval-not-approved', 'approval-undo-window', 'approval-not-running', 'bots-unreadable']);

export interface ActApprovalPort {
  request(requestId: string): StoredApproval | null;
  /** Null when the request behind the row allows it now, else why not. */
  authorize(effect: ActEffect): string | null;
}

export interface ActExecutorPorts {
  effects: ActEffectStore;
  gh: GhActPort;
  approval: ActApprovalPort;
  emit?: (effect: ActEffect) => void;
  now?: () => number;
  log?: (line: string) => void;
  reconcileAfterMs?: number;
}

// ── GitHub reads (also the request-time reads, approvals.ts) ───────────────

type Read<T> = T | { error: string; status?: number };

export interface IssueFacts {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  locked: boolean;
  isPr: boolean;
  title: string;
  closedBy: string | null;
  /** `state_reason` (completed, not_planned, reopened), or null. */
  stateReason: string | null;
  closedAt: number | null;
  url: string;
}

export interface PullFacts {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  title: string;
  url: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function loginOf(v: unknown): string | null {
  const l = rec(v)?.login;
  return typeof l === 'string' && l ? l.toLowerCase() : null;
}

function failed(a: Exclude<GhActAnswer, { ok: true }>): { error: string; status?: number } {
  return { error: a.message.slice(0, 300), ...(a.kind === 'http' ? { status: a.status } : {}) };
}

/** `host` and `repos/<owner>/<repo>` of a GitHub repo key, or null. */
export function repoPath(repoKey: string): { host: string; base: string } | null {
  const p = splitRepoKey(repoKey);
  return p ? { host: p.host, base: `repos/${p.owner}/${p.repo}` } : null;
}

/** The gh login, or why not. An answer without a status (a rate limit, a
 *  timeout, GitHub's 5xx, a gh not started) says nothing about who is
 *  signed in; one with a status is GitHub's own answer. */
export async function readIdentity(gh: GhActPort, host: string): Promise<Read<string>> {
  const a = await gh.read(host, 'user');
  if (!a.ok) return failed(a);
  return loginOf(a.value) ?? { error: 'GitHub named no login', status: 200 };
}

export async function readLogin(gh: GhActPort, host: string): Promise<string | null> {
  const a = await readIdentity(gh, host);
  return typeof a === 'string' ? a : null;
}

export async function readRepo(gh: GhActPort, repoKey: string): Promise<Read<ApprovalActRepo>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, p.base);
  if (!a.ok) return failed(a);
  const v = rec(a.value);
  const fullName = str(v?.full_name);
  const nodeId = str(v?.node_id);
  return fullName && nodeId && typeof v?.id === 'number' ? { fullName, nodeId, id: v.id } : { error: 'the repository could not be read' };
}

export function mapIssue(value: unknown): IssueFacts | null {
  const v = rec(value);
  if (!v || typeof v.number !== 'number' || !str(v.node_id)) return null;
  return {
    number: v.number, nodeId: str(v.node_id), state: v.state === 'closed' ? 'closed' : 'open', locked: v.locked === true,
    isPr: rec(v.pull_request) !== null, title: str(v.title), closedBy: loginOf(v.closed_by),
    stateReason: str(v.state_reason) || null, closedAt: Number.isFinite(Date.parse(str(v.closed_at))) ? Date.parse(str(v.closed_at)) : null,
    url: str(v.html_url),
  };
}

export function mapPull(value: unknown): PullFacts | null {
  const v = rec(value);
  const head = rec(v?.head);
  if (!v || typeof v.number !== 'number' || !str(v.node_id) || !str(head?.sha)) return null;
  return {
    number: v.number, nodeId: str(v.node_id), state: v.state === 'closed' ? 'closed' : 'open', merged: v.merged === true,
    headSha: str(head?.sha), title: str(v.title), url: str(v.html_url),
  };
}

export async function readIssue(gh: GhActPort, repoKey: string, n: number): Promise<Read<IssueFacts>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, `${p.base}/issues/${n}`);
  if (!a.ok) return failed(a);
  return mapIssue(a.value) ?? { error: 'the issue could not be read' };
}

export async function readPull(gh: GhActPort, repoKey: string, n: number): Promise<Read<PullFacts>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, `${p.base}/pulls/${n}`);
  if (!a.ok) return failed(a);
  return mapPull(a.value) ?? { error: 'the pull request could not be read' };
}

function isError<T>(r: Read<T>): r is { error: string; status?: number } {
  return !!r && typeof r === 'object' && 'error' in r;
}

/** What a failed read means for the try: with no HTTP status (a rate limit,
 *  a gh that did not start) it is `read-failed` and the try is given back;
 *  GitHub's 404 or 410 is `gone`; any other status (a 403 from SSO, a 422)
 *  refuses as `gh-<status>`, so the row never goes round again for it. */
function readRefusal(e: { status?: number }, gone: string): string {
  if (e.status === undefined) return 'read-failed';
  return e.status === 404 || e.status === 410 ? gone : `gh-${e.status}`;
}

/** Every item of a listing (`endpoint` holds a query), read 100 a page, or
 *  null when a page could not be read or there are more than LIST_PAGES_MAX:
 *  a listing that is not whole proves nothing is there. */
async function readList(gh: GhActPort, host: string, endpoint: string): Promise<unknown[] | null> {
  const out: unknown[] = [];
  for (let page = 1; page <= LIST_PAGES_MAX; page += 1) {
    const a = await gh.read(host, `${endpoint}&per_page=100&page=${page}`);
    if (!a.ok || !Array.isArray(a.value)) return null;
    out.push(...(a.value as unknown[]));
    if (a.value.length < 100) return out;
  }
  return null;
}

// ── What a write's answer must be ─────────────────────────────────────────

/** The result of a write whose answer is the act done as approved, or null
 *  (the try is uncertain). Pure. */
export function writeResult(r: Pick<StoredApproval, 'requestId' | 'ghLogin'>, act: ApprovalAct, value: unknown): ActEffect['result'] | null {
  const v = rec(value);
  if (!v) return null;
  const url = str(v.html_url);
  if (!/^https:\/\//.test(url)) return null;
  const by = loginOf(v.user);
  switch (act.kind) {
    case 'comment':
      return typeof v.id === 'number' && by === r.ghLogin && str(v.body).includes(actMarker(r.requestId)) ? { url, id: v.id } : null;
    case 'issue_create':
      return typeof v.number === 'number' && rec(v.pull_request) === null && by === r.ghLogin && str(v.body).includes(actMarker(r.requestId))
        ? { url, number: v.number } : null;
    case 'issue_close':
      return v.number === act.number && v.state === 'closed' ? { url, number: act.number } : null;
    case 'pr_close':
      return v.number === act.number && v.state === 'closed' && v.merged !== true ? { url, number: act.number } : null;
  }
}

// ── The executor ───────────────────────────────────────────────────────────

type Found = { status: 'done'; result: NonNullable<ActEffect['result']> } | { status: 'refused'; reason: string } | { status: 'none' } | { status: 'unknown' };

export class ActExecutor {
  private readonly running = new Map<string, Promise<ActEffect | null>>();
  private readonly now: () => number;

  constructor(private readonly ports: ActExecutorPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** Run one row's next step. Concurrent calls for one id share the run. */
  run(id: string): Promise<ActEffect | null> {
    const live = this.running.get(id);
    if (live) return live;
    const p = this.runOnce(id).catch((err: unknown) => {
      this.ports.log?.(`[factory] act ${id} failed: ${String(err)}`);
      return this.ports.effects.get(id);
    }).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Wait for the runs under way. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /** Startup and the sweep: settle the rows that may have run, run the
   *  pending rows whose request allows it now, and settle the pending rows
   *  whose request never will (the run refuses them); drop the rows whose
   *  request is gone. */
  async reconcileAll(): Promise<void> {
    for (const row of this.ports.effects.list()) {
      if (!runnableAct(row) || (row.status !== 'uncertain' && row.status !== 'pending')) continue;
      const denied = this.ports.approval.authorize(row);
      if (denied === 'approval-missing') this.orphaned(row);
      else if (row.status === 'uncertain' || denied === null || !ACT_NOT_NOW.has(denied)) await this.run(row.id);
    }
  }

  /** A row whose request is gone: the act's text and login went with it, so
   *  no read can settle it. Dropped, and logged; a claimed row only once its
   *  read window passed. */
  private orphaned(row: ActEffect): void {
    const claimed = actRowClaimed(row);
    if (claimed && this.now() - (row.startedAt ?? row.updatedAt) < (this.ports.reconcileAfterMs ?? RECONCILE_AFTER_MS)) return;
    if (!this.ports.effects.drop(row.id)) return;
    this.ports.log?.(`[factory] act ${row.action} ${row.requestId} dropped: its request is gone (${row.status}, attempt ${row.attempt}${claimed ? '; whether it reached GitHub is not known' : ''})`);
  }

  private emit(e: ActEffect | null): void {
    if (!e) return;
    try { this.ports.emit?.(e); } catch { /* a listener never breaks the outbox */ }
  }

  private async runOnce(id: string): Promise<ActEffect | null> {
    const { effects } = this.ports;
    let row = effects.get(id);
    if (!row || !runnableAct(row)) return row;
    if (row.status === 'uncertain' || (row.status === 'pending' && row.attempt > 0)) {
      // A try that may have landed (or an earlier try that ended without
      // proof either way): read GitHub before anything is sent again.
      if (row.status === 'uncertain' && this.now() - (row.startedAt ?? row.updatedAt) < (this.ports.reconcileAfterMs ?? RECONCILE_AFTER_MS)) return row;
      const settled = await this.reconcile(row);
      if (settled === 'unknown') return row;
      row = settled;
    }
    if (!row || row.status !== 'pending') return row;
    const claimed = effects.claim(id);
    if (!claimed) return effects.get(id);
    this.emit(claimed);
    const end = (status: 'done' | 'refused' | 'uncertain', reason?: string, result?: ActEffect['result']): ActEffect | null => {
      const out = effects.finish(id, status, reason, result);
      this.ports.log?.(`[factory] act ${claimed.action} ${claimed.requestId} ${out?.status ?? status}${out?.reason ? ` (${out.reason})` : ''}`);
      this.emit(out);
      return out;
    };
    const back = (reason: string): ActEffect | null => {
      const out = effects.release(id, reason);
      this.emit(out);
      return out;
    };
    const stop = (denied: string): ActEffect | null => (ACT_NOT_NOW.has(denied) ? back(denied) : end('refused', denied));
    try {
      const gate = (): string | null => this.ports.approval.authorize(claimed);
      const denied = gate();
      if (denied) return stop(denied);
      const r = this.ports.approval.request(claimed.requestId);
      const act = r?.act;
      const p = r ? repoPath(r.repoKey) : null;
      if (!r || !act || !p || !r.actRepo || !r.ghLogin) return end('refused', 'approval-mismatch');
      const login = await readIdentity(this.ports.gh, p.host);
      if (isError(login)) return login.status === undefined ? back('read-failed') : end('refused', 'identity-unknown');
      if (login !== r.ghLogin) return end('refused', 'identity-changed');
      const repo = await readRepo(this.ports.gh, r.repoKey);
      if (isError(repo)) {
        const why = readRefusal(repo, 'repo-changed');
        return why === 'read-failed' ? back(why) : end('refused', why);
      }
      // The name, node id and numeric id the request read (a rename or a
      // transfer changes the name; a repository made again changes the ids).
      if (repo.fullName.toLowerCase() !== r.actRepo.fullName.toLowerCase() || repo.nodeId !== r.actRepo.nodeId || repo.id !== r.actRepo.id) return end('refused', 'repo-changed');
      const pre = await this.precondition(r.repoKey, act);
      if (pre === 'read-failed') return back(pre);
      if (pre) return end('refused', pre);
      const late = gate();
      if (late) return stop(late);
      const ans = await this.write(p, r, act);
      if (ans.ok) {
        const result = writeResult(r, act, ans.value);
        return result ? end('done', undefined, result) : end('uncertain', 'unexpected-response');
      }
      if (ans.kind === 'http') return end('refused', `gh-${ans.status}`);
      if (ans.kind === 'rate-limited' || ans.kind === 'unsent') return back(ans.kind);
      return end('uncertain', 'write-error');
    } catch (err) {
      this.ports.log?.(`[factory] act ${id} failed: ${String(err)}`);
      return end('uncertain', 'executor-error');
    }
  }

  /** Why the act may not run on GitHub as it stands now, `read-failed`, or null. */
  private async precondition(repoKey: string, act: ApprovalAct): Promise<string | null> {
    const gh = this.ports.gh;
    if (act.kind === 'issue_create') return null;
    if (act.kind === 'pr_close') {
      const pr = await readPull(gh, repoKey, act.number);
      if (isError(pr)) return readRefusal(pr, 'target-gone');
      if (pr.nodeId !== act.targetNodeId) return 'target-changed';
      if (pr.merged) return 'merged';
      if (pr.state === 'closed') return 'already-closed';
      return pr.headSha === act.headSha ? null : 'head-moved';
    }
    const issue = await readIssue(gh, repoKey, act.number);
    if (isError(issue)) return readRefusal(issue, 'target-gone');
    if (issue.nodeId !== act.targetNodeId) return 'target-changed';
    if (act.kind === 'issue_close') {
      if (issue.isPr) return 'target-changed';
      return issue.state === 'closed' ? 'already-closed' : null;
    }
    if (issue.isPr !== (act.target === 'pr')) return 'target-changed';
    if (issue.locked) return 'locked';
    if (act.target === 'issue') return issue.state === 'closed' ? 'already-closed' : null;
    const pr = await readPull(gh, repoKey, act.number);
    if (isError(pr)) return readRefusal(pr, 'target-gone');
    if (pr.merged) return 'merged';
    if (pr.state === 'closed') return 'already-closed';
    return pr.headSha === act.headSha ? null : 'head-moved';
  }

  private write(p: { host: string; base: string }, r: StoredApproval, act: ApprovalAct): Promise<GhActAnswer> {
    const gh = this.ports.gh;
    switch (act.kind) {
      case 'comment':
        return gh.write(p.host, 'POST', `${p.base}/issues/${act.number}/comments`, { body: bodyWithMarker(act.body, r.requestId) });
      case 'issue_create':
        return gh.write(p.host, 'POST', `${p.base}/issues`, { title: act.title, body: bodyWithMarker(act.body, r.requestId) });
      case 'issue_close':
        return gh.write(p.host, 'PATCH', `${p.base}/issues/${act.number}`, { state: 'closed', state_reason: act.stateReason });
      case 'pr_close':
        return gh.write(p.host, 'PATCH', `${p.base}/pulls/${act.number}`, { state: 'closed' });
    }
  }

  /** Settle a row that may have run from a read of GitHub; `unknown` when
   *  the read cannot say (nothing is sent then). */
  private async reconcile(row: ActEffect): Promise<ActEffect | null | 'unknown'> {
    const r = this.ports.approval.request(row.requestId);
    if (!r?.act || !r.ghLogin) return 'unknown';
    const found = await this.find(r, r.act, row).catch((): Found => ({ status: 'unknown' }));
    if (found.status === 'unknown') return 'unknown';
    let next: ActEffect | null;
    if (found.status === 'done') next = this.ports.effects.settle(row.id, 'done', undefined, found.result);
    else if (found.status === 'refused') next = this.ports.effects.settle(row.id, 'refused', found.reason);
    else next = this.ports.effects.settle(row.id, 'pending', 'not-found');
    if (next && (next.status !== row.status || next.reason !== row.reason)) this.emit(next);
    return next;
  }

  /** Whether the act is on GitHub as approved. */
  private async find(r: StoredApproval, act: ApprovalAct, row: ActEffect): Promise<Found> {
    const p = repoPath(r.repoKey);
    if (!p) return { status: 'unknown' };
    const gh = this.ports.gh;
    const since = new Date((row.firstStartedAt ?? row.createdAt) - RECONCILE_AFTER_MS).toISOString();
    const marker = actMarker(r.requestId);
    if (act.kind === 'comment' || act.kind === 'issue_create') {
      const endpoint = act.kind === 'comment'
        ? `${p.base}/issues/${act.number}/comments?since=${since}`
        : `${p.base}/issues?creator=${r.ghLogin}&state=all&since=${since}`;
      const list = await readList(gh, p.host, endpoint);
      if (!list) return { status: 'unknown' };
      const mine = list.map(rec).filter((v): v is Record<string, unknown> => !!v
        && loginOf(v.user) === r.ghLogin && str(v.body).includes(marker) && (act.kind === 'comment' || rec(v.pull_request) === null));
      if (mine.length === 0) return { status: 'none' };
      const want = bodyWithMarker(act.body, r.requestId);
      const same = mine.find((v) => normalizeActText(str(v.body)) === want && (act.kind === 'comment' || normalizeActText(str(v.title)) === act.title));
      if (!same) return { status: 'refused', reason: 'found-different' };
      const url = str(same.html_url);
      return act.kind === 'comment'
        ? { status: 'done', result: { url, ...(typeof same.id === 'number' ? { id: same.id } : {}) } }
        : { status: 'done', result: { url, ...(typeof same.number === 'number' ? { number: same.number } : {}) } };
    }
    // A close is this try's only when the target is the node the request
    // read, closed as approved (an issue's reason; a PR unmerged at the
    // card's head), by the owner's login; when GitHub names nobody, closed
    // after this request's first try started.
    if (act.kind === 'pr_close') {
      const pr = await readPull(gh, r.repoKey, act.number);
      if (isError(pr)) return { status: 'unknown' };
      if (pr.nodeId !== act.targetNodeId) return { status: 'refused', reason: 'target-changed' };
      if (pr.merged) return { status: 'refused', reason: 'merged' };
      if (pr.state === 'open') return { status: 'none' };
      if (pr.headSha !== act.headSha) return { status: 'refused', reason: 'head-moved' };
    }
    const issue = await readIssue(gh, r.repoKey, act.number);
    if (isError(issue)) return { status: 'unknown' };
    if (act.kind === 'issue_close' && (issue.nodeId !== act.targetNodeId || issue.isPr)) return { status: 'refused', reason: 'target-changed' };
    if (issue.state === 'open') return { status: 'none' };
    if (issue.closedBy !== null && issue.closedBy !== r.ghLogin) return { status: 'refused', reason: 'closed-by-other' };
    if (act.kind === 'issue_close' && issue.stateReason !== act.stateReason) return { status: 'refused', reason: 'closed-differently' };
    const ours = issue.closedBy !== null
      || (row.firstStartedAt !== undefined && issue.closedAt !== null && issue.closedAt >= row.firstStartedAt);
    return ours ? { status: 'done', result: { url: issue.url, number: act.number } } : { status: 'refused', reason: 'closed-by-other' };
  }
}
