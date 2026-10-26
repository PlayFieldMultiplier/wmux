// ─── Reading GitHub for the act outbox: what a failed read means ───────────
//
// actExecutor.ts (a comment, an issue, a close) and releaseAct.ts (a release)
// read GitHub through gh (GhActService.ts). A failed read keeps GitHub's HTTP
// status when GitHub gave one. `unreadable` marks a 2xx answer whose shape
// this build does not read: a status of its own would read as GitHub's
// refusal (`gh-200`), and no status would give the try back for an answer
// that will not change.

import { splitRepoKey } from '../github/GhIssueService';
import type { GhActAnswer, GhActPort } from '../github/GhActService';

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

export function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A user object's login, lowercased, or null. */
export function loginOf(v: unknown): string | null {
  const l = rec(v)?.login;
  return typeof l === 'string' && l ? l.toLowerCase() : null;
}

/** Pages of 100 a listing reads at most; a longer one cannot say. */
export const LIST_PAGES_MAX = 10;

/** Every item of a paged listing (`key`: the array inside an object answer,
 *  or none for an array answer), read 100 a page. A listing that is not
 *  whole proves nothing is there: a page that failed is that page's failure
 *  (its HTTP status kept), and an answer with no list, or more than
 *  LIST_PAGES_MAX pages, is unreadable. */
export async function readPaged(gh: GhActPort, host: string, endpoint: string, key?: string): Promise<Read<unknown[]>> {
  const out: unknown[] = [];
  const join = endpoint.includes('?') ? '&' : '?';
  for (let page = 1; page <= LIST_PAGES_MAX; page += 1) {
    const a = await gh.read(host, `${endpoint}${join}per_page=100&page=${page}`);
    if (!a.ok) return failed(a);
    const items = key === undefined ? a.value : rec(a.value)?.[key];
    if (!Array.isArray(items)) return unreadable('GitHub answered a listing with no list');
    out.push(...(items as unknown[]));
    if (items.length < 100) return out;
  }
  return unreadable(`GitHub listed more than ${LIST_PAGES_MAX * 100} items`);
}
