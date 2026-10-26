// ─── Reading GitHub for the act outbox: what a failed read means ───────────
//
// actExecutor.ts (a comment, an issue, a close) and releaseAct.ts (a release)
// read GitHub through gh (GhActService.ts). A failed read keeps GitHub's HTTP
// status when GitHub gave one. `unreadable` marks a 2xx answer whose shape
// this build does not read: a status of its own would read as GitHub's
// refusal (`gh-200`), and no status would give the try back for an answer
// that will not change.

import { splitRepoKey } from '../github/GhIssueService';
import type { GhActAnswer } from '../github/GhActService';

export type ReadFail = { error: string; status?: number; unreadable?: true };
export type Read<T> = T | ReadFail;

export function failed(a: Exclude<GhActAnswer, { ok: true }>): ReadFail {
  return { error: a.message.slice(0, 300), ...(a.kind === 'http' ? { status: a.status } : {}) };
}

/** A 2xx answer this build cannot read. */
export function unreadable(error: string): ReadFail {
  return { error, unreadable: true };
}

export function isFail<T>(r: Read<T>): r is ReadFail {
  return !!r && typeof r === 'object' && 'error' in r;
}

/** `host` and `repos/<owner>/<repo>` of a GitHub repo key, or null. */
export function repoPath(repoKey: string): { host: string; base: string } | null {
  const p = splitRepoKey(repoKey);
  return p ? { host: p.host, base: `repos/${p.owner}/${p.repo}` } : null;
}

/** What a failed read means for the try: with no HTTP status (a rate limit,
 *  a gh that did not start) it is `read-failed` and the try is given back;
 *  GitHub's 404 or 410 is `gone`; any other status (a 403 from SSO, a 422)
 *  refuses as `gh-<status>`, so the row never goes round again for it; an
 *  answer this build cannot read refuses as `unreadable-answer`. */
export function readRefusal(e: ReadFail, gone: string): string {
  if (e.unreadable) return 'unreadable-answer';
  if (e.status === undefined) return 'read-failed';
  return e.status === 404 || e.status === 410 ? gone : `gh-${e.status}`;
}
