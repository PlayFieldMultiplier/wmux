// ─── A release the owner approves: what main reads on GitHub, and the rules ─
//
// A `release` act (shared/botApproval.ts ApprovalReleaseAct) publishes one
// tag at one commit of the default branch, in one of two modes, decided when
// the bot asks from the workflows at that commit (a commit's contents never
// change, so neither does the mode):
//
//   workflow  a workflow there runs on pushing this tag (its `on.push.tags`
//             or `tags-ignore` take it): main pushes the tag alone (`POST
//             git/refs`), and that workflow builds and publishes the release.
//   release   no workflow there names tags: main publishes it itself, a
//             draft first (`draft: true` makes no tag, and a 4xx on it leaves
//             none), its id journaled on the outbox row, then `PATCH draft:
//             false`. Never one `POST /releases` with `draft: false`: GitHub
//             was measured answering that 422 and creating the tag all the
//             same, which starts the repository's tag workflows.
//
// Workflows with tag filters that all pass this tag by refuse the request
// (`tag-not-matching-release-workflow`): pushing it would publish nothing. A
// workflow file that cannot be read or has a shape this reading does not
// know refuses it too, rather than guessing which mode is safe.
//
// The reads fail closed: a listing that is not whole (a page that failed,
// more pages than LIST_PAGES_MAX) proves nothing is there. Names GitHub gave
// (the default branch, a workflow's file name) are percent-encoded into the
// endpoint; the tag and the SHA are already plain (RELEASE_TAG_RE, 40 hex).

import { parse as parseYaml } from 'yaml';
import { splitRepoKey } from '../github/GhIssueService';
import type { GhActAnswer, GhActPort } from '../github/GhActService';
import type { ApprovalReleaseAct } from '../../shared/botApproval';

type Fail = { error: string; status?: number };
type Read<T> = T | Fail;
type RepoPath = { host: string; base: string };

/** Pages of 100 a listing reads at most; a longer one cannot say. */
const LIST_PAGES_MAX = 10;
/** Workflow files read at most; a repository with more cannot be read whole. */
const WORKFLOWS_MAX = 100;

// ── The tag ──────────────────────────────────────────────────────────────

/** One ref segment: what `git check-ref-format` takes, in plain characters. */
export const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Why a tag name cannot be a release's tag, or null. Pure. */
export function releaseTagProblem(tag: string): string | null {
  if (!RELEASE_TAG_RE.test(tag)) return 'tagName is one ref segment: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 100 characters';
  if (tag.includes('..') || tag.endsWith('.lock') || tag.endsWith('.')) return 'tagName may not hold "..", or end in ".lock" or "."';
  return null;
}

const SEMVER_RE = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The semver a `v?<semver>` tag names (without `v` or build metadata), or null. Pure. */
export function tagVersion(tag: string): string | null {
  return SEMVER_RE.exec(tag)?.[1] ?? null;
}

/** Whether the tag reads as a prerelease: a semver with a prerelease part
 *  does, a tag with no `-` does not; any other tag says nothing (null). Pure. */
export function tagPrereleaseShape(tag: string): boolean | null {
  const m = SEMVER_RE.exec(tag);
  if (m) return m[2] !== undefined;
  return tag.includes('-') ? null : false;
}

// ── Workflows: which run on a tag push, which on a push to a branch ─────

/** `on.push` of one workflow, as GitHub reads it: the filters it names
 *  (`{}` when it names none: every branch and every tag). */
export interface PushFilter {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
}

export interface WorkflowPush {
  path: string;
  /** Null: the workflow does not run on a push. */
  push: PushFilter | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** One filter pattern as a regular expression, in GitHub's syntax: `*` any
 *  run without `/`, `**` any run, `?` and `+` zero-or-one and one-or-more of
 *  the character before, `[…]` a class of plain characters and ranges, `\`
 *  escapes. Throws on anything else (the workflow is not read). Pure. */
export function filterRegex(pattern: string): RegExp {
  let out = '';
  let atom = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1;
      if (i >= pattern.length) throw new Error(`a filter ends in "\\": ${pattern}`);
      out += pattern[i].replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      atom = true;
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else out += '[^/]*';
      atom = true;
    } else if (c === '?' || c === '+') {
      if (!atom) throw new Error(`"${c}" follows nothing in the filter ${pattern}`);
      out += c;
      atom = false;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = end > i ? pattern.slice(i + 1, end) : '';
      if (!/^[A-Za-z0-9._-]+$/.test(body)) throw new Error(`a character class this reading does not know in ${pattern}`);
      out += `[${body.replace(/\./g, '\\.')}]`;
      i = end;
      atom = true;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      atom = true;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether a name passes a `branches` / `tags` list: patterns in order, a
 *  `!pattern` taking back what an earlier one matched. Pure. */
function listMatches(patterns: readonly string[], name: string): boolean {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (filterRegex(p.slice(1)).test(name)) hit = false;
    } else if (filterRegex(p).test(name)) hit = true;
  }
  return hit;
}

function anyMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => filterRegex(p).test(name));
}

/** A workflow's `on.push`, or null when it does not run on a push. Throws
 *  on a shape this reading does not know (fail closed). Pure. */
export function workflowPush(text: string): PushFilter | null {
  const doc = rec(parseYaml(text) as unknown);
  if (!doc || !('on' in doc)) throw new Error('it has no "on"');
  const on = doc.on;
  if (typeof on === 'string') return on === 'push' ? {} : null;
  if (Array.isArray(on)) {
    if (!on.every((e) => typeof e === 'string')) throw new Error('its "on" list holds something other than event names');
    return on.includes('push') ? {} : null;
  }
  const events = rec(on);
  if (!events) throw new Error('its "on" is not an event, a list or a map');
  if (!('push' in events)) return null;
  if (events.push === null) return {};
  const push = rec(events.push);
  if (!push) throw new Error('its "on.push" is not a map');
  const list = (key: string): string[] | undefined => {
    const v = push[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return [v];
    if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return v as string[];
    throw new Error(`its "on.push.${key}" is not a list of patterns`);
  };
  const out: PushFilter = {};
  const branches = list('branches');
  const branchesIgnore = list('branches-ignore');
  const tags = list('tags');
  const tagsIgnore = list('tags-ignore');
  if (branches && branchesIgnore) throw new Error('it names both branches and branches-ignore');
  if (tags && tagsIgnore) throw new Error('it names both tags and tags-ignore');
  if (branches) out.branches = branches;
  if (branchesIgnore) out.branchesIgnore = branchesIgnore;
  if (tags) out.tags = tags;
  if (tagsIgnore) out.tagsIgnore = tagsIgnore;
  // Every pattern is read now, so a match later cannot throw.
  for (const p of [...(branches ?? []), ...(tags ?? [])]) filterRegex(p.startsWith('!') ? p.slice(1) : p);
  for (const p of [...(branchesIgnore ?? []), ...(tagsIgnore ?? [])]) {
    if (p.startsWith('!')) throw new Error(`"!" in an ignore list: ${p}`);
    filterRegex(p);
  }
  return out;
}

/** A workflow that names tags on its push (a tag workflow). Pure. */
export function namesTags(push: PushFilter | null): boolean {
  return !!push && (push.tags !== undefined || push.tagsIgnore !== undefined);
}

/** Whether pushing this tag runs the workflow. A push with no filters runs
 *  on every tag; one that names only branches runs on none. Pure. */
export function runsOnTag(push: PushFilter | null, tag: string): boolean {
  if (!push) return false;
  if (push.tags) return listMatches(push.tags, tag);
  if (push.tagsIgnore) return !anyMatches(push.tagsIgnore, tag);
  return push.branches === undefined && push.branchesIgnore === undefined;
}

/** Whether a push to this branch runs the workflow. Pure. */
export function runsOnBranch(push: PushFilter | null, branch: string): boolean {
  if (!push) return false;
  if (push.branches) return listMatches(push.branches, branch);
  if (push.branchesIgnore) return !anyMatches(push.branchesIgnore, branch);
  return push.tags === undefined && push.tagsIgnore === undefined;
}

/** The mode of a release of this tag over these workflows: `workflow` with
 *  the tag workflows that run on it, `release` when none names tags, or the
 *  refusal when tag workflows exist and none runs on it. Pure. */
export function releaseMode(workflows: readonly WorkflowPush[], tag: string): { mode: 'workflow'; workflows: string[] } | { mode: 'release' } | { refusal: 'tag-not-matching-release-workflow' } {
  const tagged = workflows.filter((w) => namesTags(w.push));
  if (tagged.length === 0) return { mode: 'release' };
  const run = tagged.filter((w) => runsOnTag(w.push, tag)).map((w) => w.path).sort();
  return run.length > 0 ? { mode: 'workflow', workflows: run } : { refusal: 'tag-not-matching-release-workflow' };
}

// ── Checks ───────────────────────────────────────────────────────────────

/** What the checks on a commit say: every check run done and passed (or
 *  neutral, skipped), and the combined status success or no statuses at all. */
export type ReleaseChecks = 'passed' | 'failed' | 'running' | 'none' | 'not-started';

const CONCLUSION_OK: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

/** The verdict over what GitHub listed. `pushOnDefault`: a workflow at the
 *  commit runs on a push to the default branch, so a commit with no run at
 *  all has not started its checks yet. Pure. */
export function checksVerdict(o: {
  runs: ReadonlyArray<{ status: string; conclusion: string | null }>;
  status: { state: string; total: number };
  workflowRuns: ReadonlyArray<{ status: string; conclusion: string | null }> | null;
  pushOnDefault: boolean;
}): ReleaseChecks {
  const bad = (r: { status: string; conclusion: string | null }): boolean => r.status === 'completed' && !CONCLUSION_OK.has(r.conclusion ?? '');
  const running = (r: { status: string }): boolean => r.status !== 'completed';
  // GitHub answers `pending` for a commit with no statuses: read the count.
  const statuses = o.status.total > 0;
  if (o.runs.some(bad) || (statuses && (o.status.state === 'failure' || o.status.state === 'error'))) return 'failed';
  if (o.runs.some(running) || (statuses && o.status.state !== 'success')) return 'running';
  if (o.runs.length > 0) return 'passed';
  const wf = o.workflowRuns ?? [];
  if (wf.some(bad)) return 'failed';
  if (wf.some(running)) return 'running';
  if (wf.length === 0 && o.pushOnDefault) return 'not-started';
  return statuses || wf.length > 0 ? 'passed' : 'none';
}

/** The run-time refusal for a verdict, or null. Pure. */
export function checksRefusal(c: ReleaseChecks): string | null {
  return c === 'failed' ? 'checks-failing' : c === 'running' ? 'checks-pending' : c === 'not-started' ? 'checks-not-started' : null;
}

// ── Versions ─────────────────────────────────────────────────────────────

/** Why the versions at the commit are not the tag's, or null: package.json's
 *  `version`, and package-lock.json's top-level `version` and
 *  `packages[""].version`, each where it is there. Pure. */
export function versionProblem(tag: string, pkg: string | null, lock: string | null): string | null {
  const want = tagVersion(tag);
  if (!want) return null;
  const read = (text: string | null, what: string): Record<string, unknown> | null => {
    if (text === null) return null;
    try {
      return rec(JSON.parse(text) as unknown);
    } catch {
      throw new Error(`${what} is not JSON`);
    }
  };
  const p = read(pkg, 'package.json');
  const l = read(lock, 'package-lock.json');
  const found: Array<[string, unknown]> = [];
  if (p && 'version' in p) found.push(['package.json', p.version]);
  if (l && 'version' in l) found.push(['package-lock.json', l.version]);
  const root = rec(rec(l?.packages)?.['']);
  if (root && 'version' in root) found.push(['package-lock.json packages[""]', root.version]);
  for (const [where, v] of found) {
    if (v !== want) return `${where} says ${typeof v === 'string' ? v : JSON.stringify(v)}, the tag says ${want}`;
  }
  return null;
}

// ── GitHub's answers ─────────────────────────────────────────────────────

/** A release as GitHub lists it. */
export interface GhRelease {
  id: number;
  tagName: string;
  draft: boolean;
  prerelease: boolean;
  author: string | null;
  url: string;
  target: string;
  name: string;
  body: string;
}

function loginOf(v: unknown): string | null {
  const l = rec(v)?.login;
  return typeof l === 'string' && l ? l.toLowerCase() : null;
}

export function mapRelease(value: unknown): GhRelease | null {
  const v = rec(value);
  if (!v || !Number.isSafeInteger(v.id) || typeof v.tag_name !== 'string' || typeof v.draft !== 'boolean') return null;
  return {
    id: v.id as number, tagName: v.tag_name, draft: v.draft, prerelease: v.prerelease === true, author: loginOf(v.author),
    url: str(v.html_url), target: str(v.target_commitish), name: str(v.name), body: str(v.body),
  };
}

/** Whether a draft holds exactly what the act publishes. Pure. */
export function sameDraft(r: GhRelease, act: ApprovalReleaseAct): boolean {
  return r.draft && r.tagName === act.tagName && r.target === act.targetSha && r.name === act.title && r.body === act.notes && r.prerelease === act.prerelease;
}

/** A draft this act made: by the owner's login, with the act's tag, and
 *  either the draft the row journaled or one that holds exactly the act
 *  (a draft made before its id reached the journal). Pure. */
export function ownDraft(r: GhRelease, act: ApprovalReleaseAct, login: string, draftId: number | undefined): boolean {
  return r.draft && r.tagName === act.tagName && r.author === login && (r.id === draftId || sameDraft(r, act));
}

/** The bodies main sends, nothing else (`make_latest` is one of two
 *  constants: GitHub takes any string there without a word). Pure. */
export function tagRefBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return { ref: `refs/tags/${act.tagName}`, sha: act.targetSha };
}

export function draftBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return { tag_name: act.tagName, target_commitish: act.targetSha, name: act.title, body: act.notes, draft: true, prerelease: act.prerelease };
}

export function publishBody(act: ApprovalReleaseAct): Record<string, unknown> {
  return { draft: false, make_latest: act.prerelease ? 'false' : 'true' };
}

/** Whether `POST git/refs` answered the tag as approved. Pure. */
export function tagRefWritten(value: unknown, act: ApprovalReleaseAct): boolean {
  const v = rec(value);
  const o = rec(v?.object);
  return v?.ref === `refs/tags/${act.tagName}` && o?.sha === act.targetSha && o?.type === 'commit';
}

/** A draft as approved, made by the owner's login: its id, or null. Pure. */
export function draftWritten(value: unknown, act: ApprovalReleaseAct, login: string): GhRelease | null {
  const r = mapRelease(value);
  return r && r.author === login && sameDraft(r, act) ? r : null;
}

/** A published release as approved, by the owner's login: url and id, or null. Pure. */
export function publishedWritten(value: unknown, act: ApprovalReleaseAct, login: string, draftId: number): { url: string; id: number } | null {
  const r = mapRelease(value);
  if (!r || r.id !== draftId || r.draft || r.tagName !== act.tagName || r.prerelease !== act.prerelease || r.author !== login) return null;
  return /^https:\/\//.test(r.url) ? { url: r.url, id: r.id } : null;
}

// ── Reads ────────────────────────────────────────────────────────────────

function failed(a: Exclude<GhActAnswer, { ok: true }>): Fail {
  return { error: a.message.slice(0, 300), ...(a.kind === 'http' ? { status: a.status } : {}) };
}

export function isFail<T>(r: Read<T>): r is Fail {
  return !!r && typeof r === 'object' && 'error' in r;
}

/** A name GitHub gave, as path segments (each percent-encoded). Pure. */
export function pathOfName(name: string): string {
  return name.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export function releaseRepoPath(repoKey: string): RepoPath | null {
  const p = splitRepoKey(repoKey);
  return p ? { host: p.host, base: `repos/${p.owner}/${p.repo}` } : null;
}

export async function readDefaultBranch(gh: GhActPort, p: RepoPath): Promise<Read<string>> {
  const a = await gh.read(p.host, p.base);
  if (!a.ok) return failed(a);
  const b = str(rec(a.value)?.default_branch);
  return b ? b : { error: 'GitHub named no default branch', status: 200 };
}

export async function readBranchHead(gh: GhActPort, p: RepoPath, branch: string): Promise<Read<string>> {
  const a = await gh.read(p.host, `${p.base}/git/ref/heads/${pathOfName(branch)}`);
  if (!a.ok) return failed(a);
  const o = rec(rec(a.value)?.object);
  return o?.type === 'commit' && FULL_SHA_RE.test(str(o.sha)) ? str(o.sha) : { error: 'the branch head could not be read', status: 200 };
}

/** Whether `sha` names a commit: true, false (GitHub's 404 or 422), or why not known. */
export async function readCommitExists(gh: GhActPort, p: RepoPath, sha: string): Promise<Read<boolean>> {
  const a = await gh.read(p.host, `${p.base}/commits/${sha}`);
  if (!a.ok) return a.kind === 'http' && (a.status === 404 || a.status === 422) ? false : failed(a);
  return str(rec(a.value)?.sha) === sha;
}

/** How the default branch's head stands to `sha`: `identical` or `ahead`
 *  (the commit is on it, `aheadBy` commits back), or another status. */
export async function readCompare(gh: GhActPort, p: RepoPath, sha: string, branch: string): Promise<Read<{ status: string; aheadBy: number }>> {
  const a = await gh.read(p.host, `${p.base}/compare/${sha}...heads/${pathOfName(branch)}?per_page=1`);
  if (!a.ok) return failed(a);
  const v = rec(a.value);
  return { status: str(v?.status), aheadBy: typeof v?.ahead_by === 'number' ? v.ahead_by : 0 };
}

/** The commit a tag points at (an annotated tag read through), null when
 *  there is no such tag, or why not known. */
export async function readTagTarget(gh: GhActPort, p: RepoPath, tag: string): Promise<Read<string | null>> {
  const a = await gh.read(p.host, `${p.base}/git/ref/tags/${tag}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  // The one ref of that exact name (a list answers refs that only start so).
  const ref = Array.isArray(a.value)
    ? (a.value as unknown[]).map(rec).find((r) => r?.ref === `refs/tags/${tag}`) ?? null
    : rec(a.value);
  if (!ref) return null;
  if (ref.ref !== `refs/tags/${tag}`) return { error: 'GitHub answered another ref', status: 200 };
  let o = rec(ref.object);
  for (let hops = 0; hops < 4 && o?.type === 'tag'; hops += 1) {
    const t = await gh.read(p.host, `${p.base}/git/tags/${str(o.sha)}`);
    if (!t.ok) return failed(t);
    o = rec(rec(t.value)?.object);
  }
  return o?.type === 'commit' && FULL_SHA_RE.test(str(o.sha)) ? str(o.sha) : { error: 'the tag points at something other than a commit', status: 200 };
}

/** The published release of a tag, or null (GitHub's 404: drafts answer
 *  404 here; readReleases lists them). */
export async function readReleaseByTag(gh: GhActPort, p: RepoPath, tag: string): Promise<Read<GhRelease | null>> {
  const a = await gh.read(p.host, `${p.base}/releases/tags/${tag}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  return mapRelease(a.value) ?? { error: 'the release could not be read', status: 200 };
}

/** Every item of a paged listing (`key`: the array inside an object answer,
 *  or none for an array answer), or null when it is not whole. */
async function readPaged(gh: GhActPort, host: string, endpoint: string, key?: string): Promise<unknown[] | null> {
  const out: unknown[] = [];
  const join = endpoint.includes('?') ? '&' : '?';
  for (let page = 1; page <= LIST_PAGES_MAX; page += 1) {
    const a = await gh.read(host, `${endpoint}${join}per_page=100&page=${page}`);
    if (!a.ok) return null;
    const items = key === undefined ? a.value : rec(a.value)?.[key];
    if (!Array.isArray(items)) return null;
    out.push(...(items as unknown[]));
    if (items.length < 100) return out;
  }
  return null;
}

/** Every release of the repository, drafts included, or null. */
export async function readReleases(gh: GhActPort, p: RepoPath): Promise<GhRelease[] | null> {
  const list = await readPaged(gh, p.host, `${p.base}/releases`);
  if (!list) return null;
  const out: GhRelease[] = [];
  for (const v of list) {
    const r = mapRelease(v);
    if (!r) return null;
    out.push(r);
  }
  return out;
}

/** The files of one folder at a commit (`''`: the root), with the blob
 *  each one is, or null when there is no such folder. */
async function readFolder(gh: GhActPort, p: RepoPath, dir: string, sha: string): Promise<Read<Array<{ name: string; blob: string }> | null>> {
  const a = await gh.read(p.host, `${p.base}/contents${dir ? `/${pathOfName(dir)}` : ''}?ref=${sha}`);
  if (!a.ok) return a.kind === 'http' && a.status === 404 ? null : failed(a);
  if (!Array.isArray(a.value)) return { error: `${dir || 'the root'} is not a folder`, status: 200 };
  const out: Array<{ name: string; blob: string }> = [];
  for (const e of (a.value as unknown[]).map(rec)) {
    if (e?.type !== 'file') continue;
    if (!FULL_SHA_RE.test(str(e.sha)) || !str(e.name)) return { error: `${dir || 'the root'} could not be listed`, status: 200 };
    out.push({ name: str(e.name), blob: str(e.sha) });
  }
  return out;
}

/** A blob's text. Read through the blob, whatever its size: `contents/`
 *  answers a file over 1 MB with a 403 (`too_large`) in the JSON GitHub
 *  gives gh by default. */
async function readBlob(gh: GhActPort, p: RepoPath, blob: string, what: string): Promise<Read<string>> {
  const b = await gh.read(p.host, `${p.base}/git/blobs/${blob}`);
  if (!b.ok) return failed(b);
  const v = rec(b.value);
  if (v?.encoding !== 'base64') return { error: `${what} could not be read`, status: 200 };
  return Buffer.from(str(v.content), 'base64').toString('utf8');
}

/** A file's text at a commit, null when it is not there. */
export async function readFileAt(gh: GhActPort, p: RepoPath, path: string, sha: string): Promise<Read<string | null>> {
  const cut = path.lastIndexOf('/');
  const folder = await readFolder(gh, p, cut < 0 ? '' : path.slice(0, cut), sha);
  if (folder === null || isFail(folder)) return folder;
  const file = folder.find((f) => f.name === path.slice(cut + 1));
  return file ? readBlob(gh, p, file.blob, path) : null;
}

/** The `on.push` of every workflow at a commit, or why they cannot be read
 *  (`refusal`: one that reads as no shape this module knows). */
export async function readWorkflows(gh: GhActPort, p: RepoPath, sha: string): Promise<Read<WorkflowPush[]> | { refusal: string }> {
  const dir = '.github/workflows';
  const folder = await readFolder(gh, p, dir, sha);
  if (folder === null) return [];
  if (isFail(folder)) return folder;
  const files = folder.filter((f) => /\.ya?ml$/i.test(f.name));
  if (files.length > WORKFLOWS_MAX) return { refusal: `the repository has more than ${WORKFLOWS_MAX} workflows` };
  const out: WorkflowPush[] = [];
  for (const f of files) {
    const path = `${dir}/${f.name}`;
    const text = await readBlob(gh, p, f.blob, path);
    if (isFail(text)) return text;
    try {
      out.push({ path, push: workflowPush(text) });
    } catch (err) {
      return { refusal: `${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
  }
  return out;
}

/** What the checks on a commit say now. */
export async function readChecks(gh: GhActPort, p: RepoPath, sha: string, pushOnDefault: boolean): Promise<Read<ReleaseChecks>> {
  const run = (v: unknown): { status: string; conclusion: string | null } => {
    const r = rec(v);
    return { status: str(r?.status), conclusion: typeof r?.conclusion === 'string' ? r.conclusion : null };
  };
  const runs = await readPaged(gh, p.host, `${p.base}/commits/${sha}/check-runs?filter=latest`, 'check_runs');
  if (!runs) return { error: 'the check runs could not be read' };
  const s = await gh.read(p.host, `${p.base}/commits/${sha}/status`);
  if (!s.ok) return failed(s);
  const sv = rec(s.value);
  if (typeof sv?.total_count !== 'number') return { error: 'the combined status could not be read', status: 200 };
  let workflowRuns: unknown[] | null = null;
  if (runs.length === 0) {
    workflowRuns = await readPaged(gh, p.host, `${p.base}/actions/runs?head_sha=${sha}`, 'workflow_runs');
    if (!workflowRuns) return { error: 'the workflow runs could not be read' };
  }
  return checksVerdict({ runs: runs.map(run), status: { state: str(sv.state), total: sv.total_count }, workflowRuns: workflowRuns?.map(run) ?? null, pushOnDefault });
}

/** The Actions run a pushed tag started, best effort: its page, or ''. */
export async function tagRunUrl(gh: GhActPort, p: RepoPath, act: ApprovalReleaseAct): Promise<string> {
  const a = await gh.read(p.host, `${p.base}/actions/runs?event=push&branch=${act.tagName}&per_page=20`).catch(() => null);
  if (!a?.ok) return '';
  const runs = rec(a.value)?.workflow_runs;
  const hit = Array.isArray(runs) ? (runs as unknown[]).map(rec).find((r) => r?.head_sha === act.targetSha && /^https:\/\//.test(str(r?.html_url))) : undefined;
  return hit ? str(hit.html_url) : '';
}

/** Delete a draft this act made, best effort. */
export async function deleteDraft(gh: GhActPort, p: RepoPath, draftId: number): Promise<boolean> {
  const a = await gh.write(p.host, 'DELETE', `${p.base}/releases/${draftId}`, {}).catch(() => null);
  return !!a && (a.ok || (a.kind === 'http' && a.status === 404));
}

// ── When the bot asks ────────────────────────────────────────────────────

export interface ReleaseAskInput {
  tagName: string;
  /** Lowercase full SHA, or absent: the default branch's head now. */
  targetSha?: string;
  prerelease?: boolean;
}

/** What main read for a release request: the pins, and the facts its card
 *  states. */
export interface ReleaseAsk {
  mode: 'workflow' | 'release';
  workflows: string[];
  targetSha: string;
  defaultBranch: string;
  /** Commits the default branch's head is ahead of the target. */
  behindBy: number;
  checks: ReleaseChecks;
  /** package.json's version at the target, when it has one. */
  version: string | null;
  /** In workflow mode, the tag's own shape where the bot named none. */
  prerelease: boolean;
}

export interface ReleaseAskRefusal {
  refuse: 'invalid' | 'read_failed';
  message: string;
}

/** Read GitHub for a release request; the request is refused (no card) when
 *  the repository cannot take this release as asked. */
export async function readReleaseAsk(gh: GhActPort, repoKey: string, input: ReleaseAskInput): Promise<ReleaseAsk | ReleaseAskRefusal> {
  const p = releaseRepoPath(repoKey);
  if (!p) return { refuse: 'invalid', message: 'not a GitHub repository' };
  const unread = (what: string, e: Fail): ReleaseAskRefusal => ({ refuse: 'read_failed', message: `${what} could not be read: ${e.error}`.slice(0, 300) });
  const no = (code: string, message: string): ReleaseAskRefusal => ({ refuse: 'invalid', message: `${code}: ${message}`.slice(0, 300) });
  const tag = input.tagName;
  const defaultBranch = await readDefaultBranch(gh, p);
  if (isFail(defaultBranch)) return unread('the repository', defaultBranch);
  let targetSha = input.targetSha;
  if (targetSha === undefined) {
    const head = await readBranchHead(gh, p, defaultBranch);
    if (isFail(head)) return unread(`the head of ${defaultBranch}`, head);
    targetSha = head;
  } else {
    const exists = await readCommitExists(gh, p, targetSha);
    if (isFail(exists)) return unread('the commit', exists);
    if (!exists) return { refuse: 'invalid', message: `targetSha ${targetSha} is not a commit of ${repoKey}` };
  }
  const cmp = await readCompare(gh, p, targetSha, defaultBranch);
  if (isFail(cmp)) return cmp.status === undefined ? unread(`how ${targetSha.slice(0, 7)} stands to ${defaultBranch}`, cmp) : no('not-on-default-branch', `GitHub could not compare ${targetSha.slice(0, 7)} with ${defaultBranch} (HTTP ${cmp.status})`);
  if (cmp.status !== 'identical' && cmp.status !== 'ahead') return no('not-on-default-branch', `${targetSha.slice(0, 7)} is not on ${defaultBranch}`);
  const taken = await readTagTarget(gh, p, tag);
  if (isFail(taken)) return unread(`the tag ${tag}`, taken);
  if (taken !== null) return no('tag-taken', `the tag ${tag} already exists`);
  const published = await readReleaseByTag(gh, p, tag);
  if (isFail(published)) return unread(`the release of ${tag}`, published);
  if (published) return no('release-exists', `a release of ${tag} is already published`);
  const all = await readReleases(gh, p);
  if (!all) return { refuse: 'read_failed', message: 'the releases could not be listed whole' };
  if (all.some((r) => r.tagName === tag)) return no('release-exists', `a draft release of ${tag} is already there`);
  const workflows = await readWorkflows(gh, p, targetSha);
  if ('refusal' in workflows) return { refuse: 'invalid', message: `${workflows.refusal}; fix it or ask the owner to publish this release` };
  if (isFail(workflows)) return unread('the workflows', workflows);
  // Every pattern was read with its workflow: matching cannot throw.
  const mode = releaseMode(workflows, tag);
  const pushOnDefault = workflows.some((w) => runsOnBranch(w.push, defaultBranch));
  if ('refusal' in mode) return no(mode.refusal, `the repository's tag workflows do not run on ${tag}, so pushing it would publish nothing`);
  const shape = tagPrereleaseShape(tag);
  if (mode.mode === 'workflow' && input.prerelease !== undefined && shape !== null && input.prerelease !== shape) {
    return no('prerelease-mismatch', `${tag} ${shape ? 'reads' : 'does not read'} as a prerelease, and its release workflow decides by the tag`);
  }
  let version: string | null = null;
  if (tagVersion(tag)) {
    const pkg = await readFileAt(gh, p, 'package.json', targetSha);
    if (isFail(pkg)) return unread('package.json', pkg);
    const lock = await readFileAt(gh, p, 'package-lock.json', targetSha);
    if (isFail(lock)) return unread('package-lock.json', lock);
    let problem: string | null;
    try {
      problem = versionProblem(tag, pkg, lock);
    } catch (err) {
      return { refuse: 'invalid', message: `version-mismatch: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (problem) return no('version-mismatch', problem);
    const v = pkg === null ? null : (rec(JSON.parse(pkg) as unknown)?.version ?? null);
    version = typeof v === 'string' ? v : null;
  }
  const checks = await readChecks(gh, p, targetSha, pushOnDefault);
  if (isFail(checks)) return unread('the checks', checks);
  return {
    mode: mode.mode, workflows: mode.mode === 'workflow' ? mode.workflows : [], targetSha, defaultBranch,
    behindBy: cmp.aheadBy, checks, version,
    prerelease: mode.mode === 'workflow' ? input.prerelease ?? shape ?? false : input.prerelease ?? false,
  };
}

// ── When it runs ─────────────────────────────────────────────────────────

/** A failed read as a run-time answer: no status gives the try back
 *  (`read-failed`); GitHub's 404 or 410 is `gone`; any other status refuses. */
function refusalOf(e: Fail, gone: string): string {
  if (e.status === undefined) return 'read-failed';
  return e.status === 404 || e.status === 410 ? gone : `gh-${e.status}`;
}

/** Why the release may not run as it stands now (`read-failed`: try again
 *  later), or null; and this act's own draft on GitHub, when there is one. */
export async function releasePrecondition(gh: GhActPort, p: RepoPath, act: ApprovalReleaseAct, login: string, draftId: number | undefined): Promise<{ refusal: string | null; draft: GhRelease | null }> {
  const stop = (refusal: string, draft: GhRelease | null = null): { refusal: string; draft: GhRelease | null } => ({ refusal, draft });
  const branch = await readDefaultBranch(gh, p);
  if (isFail(branch)) return stop(refusalOf(branch, 'repo-changed'));
  if (branch !== act.defaultBranch) return stop('default-branch-changed');
  const cmp = await readCompare(gh, p, act.targetSha, act.defaultBranch);
  if (isFail(cmp)) return stop(refusalOf(cmp, 'not-on-default-branch'));
  if (cmp.status !== 'identical' && cmp.status !== 'ahead') return stop('not-on-default-branch');
  const tag = await readTagTarget(gh, p, act.tagName);
  if (isFail(tag)) return stop(refusalOf(tag, 'tag-taken'));
  const all = await readReleases(gh, p);
  if (!all) return stop('read-failed');
  const same = all.filter((r) => r.tagName === act.tagName);
  const own = act.mode === 'release' ? same.find((r) => ownDraft(r, act, login, draftId)) ?? null : null;
  if (tag !== null) return stop('tag-taken', own);
  const published = await readReleaseByTag(gh, p, act.tagName);
  if (isFail(published)) return stop(refusalOf(published, 'release-exists'), own);
  if (published || same.some((r) => r !== own)) return stop('release-exists', own);
  // The draft this act made was changed on GitHub since: not what was approved.
  if (own && !sameDraft(own, act)) return stop('found-different', own);
  const workflows = await readWorkflows(gh, p, act.targetSha);
  if ('refusal' in workflows) return stop('workflow-unreadable', own);
  if (isFail(workflows)) return stop(refusalOf(workflows, 'workflow-unreadable'), own);
  const pushOnDefault = workflows.some((w) => runsOnBranch(w.push, act.defaultBranch));
  const checks = await readChecks(gh, p, act.targetSha, pushOnDefault);
  if (isFail(checks)) return stop(refusalOf(checks, 'checks-failing'), own);
  const why = checksRefusal(checks);
  return why ? stop(why, own) : { refusal: null, draft: own };
}

export type ReleaseFound =
  | { status: 'done'; result: { url: string; id?: number } }
  | { status: 'refused'; reason: string; result?: { url: string; id?: number }; draft?: number }
  | { status: 'none'; draft?: number }
  | { status: 'unknown' };

/** Whether the release is on GitHub as approved, read for a row that may
 *  have run. `draft`: this act's own draft, still there. */
export async function findRelease(gh: GhActPort, p: RepoPath, act: ApprovalReleaseAct, login: string, draftId: number | undefined): Promise<ReleaseFound> {
  const tag = await readTagTarget(gh, p, act.tagName);
  if (isFail(tag)) return { status: 'unknown' };
  if (act.mode === 'workflow') {
    // The write is the tag itself: at the commit, it is this act's (no one
    // else's push of that ref would differ from it).
    if (tag === null) return { status: 'none' };
    if (tag !== act.targetSha) return { status: 'refused', reason: 'tag-taken' };
    return { status: 'done', result: { url: await tagRunUrl(gh, p, act) } };
  }
  const all = await readReleases(gh, p);
  if (!all) return { status: 'unknown' };
  const same = all.filter((r) => r.tagName === act.tagName);
  const published = same.find((r) => !r.draft);
  if (published) {
    const result = { url: published.url, id: published.id };
    if (published.author !== login) return { status: 'refused', reason: 'release-by-other' };
    // A published release has its tag; one not visible yet says nothing.
    if (tag === null) return { status: 'unknown' };
    if (tag !== act.targetSha) return { status: 'refused', reason: 'published-other-target', result };
    if (published.prerelease !== act.prerelease) return { status: 'refused', reason: 'found-different', result };
    return { status: 'done', result };
  }
  const own = same.find((r) => ownDraft(r, act, login, draftId));
  if (tag !== null) return { status: 'refused', reason: 'tag-taken', ...(own ? { draft: own.id } : {}) };
  return { status: 'none', ...(own ? { draft: own.id } : {}) };
}
