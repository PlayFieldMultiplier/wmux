// A small in-memory GitHub for the act executor's tests: the answers of the
// endpoints actExecutor.ts and releaseAct.ts read and write, shaped like
// GitHub's REST.

import { createHash } from 'node:crypto';
import type { GhActAnswer, GhActMethod, GhActPort } from '../../github/GhActService';

export interface FakeIssue {
  number: number;
  node_id: string;
  title: string;
  state: 'open' | 'closed';
  locked?: boolean;
  pull_request?: Record<string, unknown>;
  closed_by?: { login: string } | null;
  closed_at?: string | null;
  state_reason?: string | null;
  user: { login: string };
  body?: string;
  html_url: string;
}

export interface FakeComment {
  id: number;
  issue: number;
  body: string;
  user: { login: string };
  html_url: string;
}

export interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  name: string;
  body: string;
  target_commitish: string;
  author: { login: string };
  html_url: string;
}

export interface FakeRun {
  status: string;
  conclusion: string | null;
  /** The ref whose check suite the run is in: `main` when unset; null for
   *  a suite an app made with no branch. */
  suiteBranch?: string | null;
}

export interface FakeWorkflowRun extends FakeRun {
  head_sha: string;
  event: string;
  head_branch: string;
  html_url: string;
  /** The workflow it is a run of, its id, and which attempt it is. */
  workflow_id?: number;
  id?: number;
  run_attempt?: number;
}

const NOT_FOUND: GhActAnswer = { ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' };

/** A check suite's id: one suite per ref (null: an app's, with no branch). */
function suiteId(branch: string | null): number {
  return branch === null ? 1 : 1000 + [...branch].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 100_000, 7);
}

/** A file's blob sha: a hash of its path (the fake's files do not change). */
function blobOf(file: string): string {
  return createHash('sha1').update(file).digest('hex');
}

export class FakeGithub implements GhActPort {
  login = 'owner';
  repo: { full_name: string; node_id: string; id: number; default_branch?: string } = { full_name: 'o/r', node_id: 'R_1', id: 4242, default_branch: 'main' };
  /** The default branch's commits, oldest first: the last is its head. */
  history: string[] = [];
  /** Commits that are not on the default branch. */
  otherCommits = new Set<string>();
  /** Tags: the commit each points at; `annotated`: through a tag object. */
  tags = new Map<string, { sha: string; annotated?: boolean }>();
  releases: FakeRelease[] = [];
  checkRuns = new Map<string, FakeRun[]>();
  statuses = new Map<string, { state: string; total_count: number }>();
  workflowRuns: FakeWorkflowRun[] = [];
  /** Files at every commit, by path; `bigFiles`: over 1 MB, which `contents/`
   *  refuses (only their blob answers). */
  files = new Map<string, string>();
  bigFiles = new Set<string>();
  /** A path listed as something other than a plain file: `symlink`, or
   *  `submodule` (which a listing reports as a file with no download link). */
  entryTypes = new Map<string, 'symlink' | 'submodule'>();
  /** A workflow file's state on GitHub (`active` when unset). */
  workflowStates = new Map<string, string>();
  /** GitHub Actions on for the repository; `forbidden`: its switch cannot be read. */
  actions: 'on' | 'off' | 'forbidden' = 'on';
  /** Called before every write is applied (a test may change state there). */
  onWrite: ((w: { method: string; endpoint: string; body: Record<string, unknown> }) => void) | null = null;
  private tagObjects = new Map<string, string>();
  issues = new Map<number, FakeIssue>();
  pulls = new Map<number, { head: string; merged: boolean }>();
  comments: FakeComment[] = [];
  writes: Array<{ method: GhActMethod; endpoint: string; body: Record<string, unknown> }> = [];
  reads: string[] = [];
  /** Replace the next write's answer (a timeout, a wrong shape, …);
   *  `landed`: GitHub took the write all the same. */
  nextWrite: { answer: GhActAnswer; landed: boolean } | null = null;
  /** Called on every read (a test may change state mid-run). */
  onRead: ((endpoint: string) => void) | null = null;
  /** A read's answer in place of GitHub's (a rate limit, a 401, a page that
   *  fails), or null for GitHub's. */
  answerRead: ((endpoint: string) => GhActAnswer | null) | null = null;
  private nextId = 100;

  addIssue(n: number, over: Partial<FakeIssue> = {}): FakeIssue {
    const i: FakeIssue = { number: n, node_id: `I_${n}`, title: `issue ${n}`, state: 'open', user: { login: 'someone' }, html_url: `https://github.com/o/r/issues/${n}`, ...over };
    this.issues.set(n, i);
    return i;
  }

  addPull(n: number, head: string): void {
    this.addIssue(n, { node_id: `PR_${n}`, title: `pr ${n}`, pull_request: { url: 'x' }, html_url: `https://github.com/o/r/pull/${n}` });
    this.pulls.set(n, { head, merged: false });
  }

  private pullJson(n: number): unknown {
    const i = this.issues.get(n);
    const p = this.pulls.get(n);
    if (!i || !p) return null;
    return { number: n, node_id: i.node_id, state: i.state, merged: p.merged, head: { sha: p.head }, title: i.title, html_url: i.html_url };
  }

  async read(_host: string, endpoint: string): Promise<GhActAnswer> {
    this.reads.push(endpoint);
    this.onRead?.(endpoint);
    const forced = this.answerRead?.(endpoint);
    if (forced) return forced;
    const path = endpoint.split('?')[0];
    const query = new URLSearchParams(endpoint.split('?')[1] ?? '');
    // A list answers one page: `per_page` (GitHub's default 30) from `page` (1).
    const page = (all: unknown[]): unknown[] => {
      const size = Number(query.get('per_page') ?? 30);
      const from = (Number(query.get('page') ?? 1) - 1) * size;
      return all.slice(from, from + size);
    };
    if (path === 'user') return { ok: true, value: { login: this.login } };
    if (path === 'repos/o/r') return { ok: true, value: this.repo };
    const release = this.readRelease(path, query, page);
    if (release) return release;
    let m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
    if (m) return { ok: true, value: page(this.comments.filter((c) => c.issue === Number(m?.[1]))) };
    m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
    if (m) {
      const i = this.issues.get(Number(m[1]));
      return i ? { ok: true, value: i } : { ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' };
    }
    m = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (m) {
      const p = this.pullJson(Number(m[1]));
      return p ? { ok: true, value: p } : { ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' };
    }
    if (path === 'repos/o/r/issues') {
      const creator = query.get('creator');
      return { ok: true, value: page([...this.issues.values()].filter((i) => !creator || i.user.login === creator)) };
    }
    return { ok: false, kind: 'http', status: 404, message: `gh: no such endpoint ${endpoint} (HTTP 404)` };
  }

  /** A tag as `git/ref/tags/<tag>` answers it. */
  private tagRef(tag: string): unknown {
    const t = this.tags.get(tag);
    if (!t) return null;
    if (!t.annotated) return { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: t.sha } };
    const obj = (this.nextId++).toString(16).padStart(40, '0');
    this.tagObjects.set(obj, t.sha);
    return { ref: `refs/tags/${tag}`, object: { type: 'tag', sha: obj } };
  }

  private known(sha: string): boolean {
    return this.history.includes(sha) || this.otherCommits.has(sha);
  }

  /** The release endpoints (releaseAct.ts), or null for any other. */
  private readRelease(path: string, query: URLSearchParams, page: (all: unknown[]) => unknown[]): GhActAnswer | null {
    let m = /^repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(path);
    if (m) {
      const head = this.history.at(-1);
      return decodeURIComponent(m[1]) === this.repo.default_branch && head ? { ok: true, value: { ref: `refs/heads/${this.repo.default_branch}`, object: { type: 'commit', sha: head } } } : NOT_FOUND;
    }
    m = /^repos\/o\/r\/git\/ref\/tags\/(.+)$/.exec(path);
    if (m) {
      const ref = this.tagRef(m[1]);
      return ref ? { ok: true, value: ref } : NOT_FOUND;
    }
    m = /^repos\/o\/r\/git\/tags\/([0-9a-f]{40})$/.exec(path);
    if (m) {
      const sha = this.tagObjects.get(m[1]);
      return sha ? { ok: true, value: { sha: m[1], object: { type: 'commit', sha } } } : NOT_FOUND;
    }
    m = /^repos\/o\/r\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (m) {
      const file = [...this.files.keys()].find((f) => blobOf(f) === m?.[1]);
      const text = file === undefined ? undefined : this.files.get(file);
      return text === undefined ? NOT_FOUND : { ok: true, value: { sha: m[1], encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') } };
    }
    m = /^repos\/o\/r\/commits\/([0-9a-f]{40})$/.exec(path);
    if (m) return this.known(m[1]) ? { ok: true, value: { sha: m[1] } } : { ok: false, kind: 'http', status: 422, message: 'gh: No commit found for SHA (HTTP 422)' };
    m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/check-suites$/.exec(path);
    if (m) {
      const branches = [...new Set((this.checkRuns.get(m[1]) ?? []).map((r) => (r.suiteBranch === undefined ? 'main' : r.suiteBranch)))];
      return { ok: true, value: { total_count: branches.length, check_suites: page(branches.map((b) => ({ id: suiteId(b), head_branch: b, head_sha: m?.[1] }))) } };
    }
    m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
    if (m) {
      const runs = (this.checkRuns.get(m[1]) ?? []).map((r) => ({ status: r.status, conclusion: r.conclusion, check_suite: { id: suiteId(r.suiteBranch === undefined ? 'main' : r.suiteBranch) } }));
      return { ok: true, value: { total_count: runs.length, check_runs: page(runs) } };
    }
    m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/status$/.exec(path);
    if (m) return { ok: true, value: this.statuses.get(m[1]) ?? { state: 'pending', total_count: 0, statuses: [] } };
    m = /^repos\/o\/r\/compare\/([0-9a-f]{40})\.\.\.heads\/(.+)$/.exec(path);
    if (m) {
      if (decodeURIComponent(m[2]) !== this.repo.default_branch || this.history.length === 0) return NOT_FOUND;
      const at = this.history.indexOf(m[1]);
      if (at < 0) return this.otherCommits.has(m[1]) ? { ok: true, value: { status: 'diverged', ahead_by: 1, behind_by: 1 } } : NOT_FOUND;
      const ahead = this.history.length - 1 - at;
      return { ok: true, value: { status: ahead === 0 ? 'identical' : 'ahead', ahead_by: ahead, behind_by: 0 } };
    }
    m = /^repos\/o\/r\/releases\/tags\/(.+)$/.exec(path);
    if (m) {
      const r = this.releases.find((x) => x.tag_name === m?.[1] && !x.draft);
      return r ? { ok: true, value: r } : NOT_FOUND;
    }
    if (path === 'repos/o/r/releases') return { ok: true, value: page(this.releases) };
    m = /^repos\/o\/r\/releases\/(\d+)$/.exec(path);
    if (m) {
      const r = this.releases.find((x) => x.id === Number(m?.[1]));
      return r ? { ok: true, value: { ...r } } : NOT_FOUND;
    }
    if (path === 'repos/o/r/actions/permissions') {
      return this.actions === 'forbidden' ? { ok: false, kind: 'http', status: 403, message: 'gh: Must have admin rights to Repository. (HTTP 403)' } : { ok: true, value: { enabled: this.actions === 'on' } };
    }
    m = /^repos\/o\/r\/actions\/workflows\/([^/]+)$/.exec(path);
    if (m) {
      const file = `.github/workflows/${decodeURIComponent(m[1])}`;
      return this.files.has(file) ? { ok: true, value: { path: file, state: this.workflowStates.get(file) ?? 'active' } } : NOT_FOUND;
    }
    if (path === 'repos/o/r/actions/runs') {
      const sha = query.get('head_sha');
      const runs = this.workflowRuns.filter((r) => (sha === null || r.head_sha === sha)
        && (query.get('event') === null || r.event === query.get('event')) && (query.get('branch') === null || r.head_branch === query.get('branch')));
      return { ok: true, value: { total_count: runs.length, workflow_runs: page(runs) } };
    }
    m = /^repos\/o\/r\/contents(?:\/(.+))?$/.exec(path);
    if (m) {
      const file = decodeURIComponent(m[1] ?? '');
      if (!this.known(query.get('ref') ?? '')) return NOT_FOUND;
      const prefix = file ? `${file}/` : '';
      const inDir = [...this.files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'));
      if (inDir.length > 0) {
        return { ok: true, value: inDir.map((f) => {
          const kind = this.entryTypes.get(f);
          return { type: kind === 'symlink' ? 'symlink' : 'file', name: f.slice(prefix.length), path: f, sha: blobOf(f), size: (this.files.get(f) ?? '').length, download_url: kind === 'submodule' ? null : `https://raw.example/${f}` };
        }) };
      }
      const text = this.files.get(file);
      if (text === undefined) return NOT_FOUND;
      // Over 1 MB, the JSON media type gh asks for is refused.
      if (this.bigFiles.has(file)) return { ok: false, kind: 'http', status: 403, message: 'gh: This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API, but you can use the Git Data API to request blobs up to 100 MB in size. (HTTP 403)' };
      return { ok: true, value: { type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64'), size: text.length, sha: blobOf(file) } };
    }
    return null;
  }

  /** The release writes, or null for any other. */
  private writeRelease(method: GhActMethod, endpoint: string, body: Record<string, unknown>): GhActAnswer | null {
    if (method === 'POST' && endpoint === 'repos/o/r/git/refs') {
      const tag = String(body.ref).replace(/^refs\/tags\//, '');
      if (this.tags.has(tag)) return { ok: false, kind: 'http', status: 422, message: 'gh: Reference already exists (HTTP 422)' };
      this.tags.set(tag, { sha: String(body.sha) });
      return { ok: true, value: { ref: body.ref, node_id: 'REF_1', object: { type: 'commit', sha: body.sha } } };
    }
    if (method === 'POST' && endpoint === 'repos/o/r/releases') {
      const tag = String(body.tag_name);
      const r: FakeRelease = {
        id: this.nextId++, tag_name: tag, draft: body.draft === true, prerelease: body.prerelease === true, name: String(body.name ?? ''), body: String(body.body ?? ''),
        target_commitish: String(body.target_commitish), author: { login: this.login }, html_url: `https://github.com/o/r/releases/tag/${tag}`,
      };
      // GitHub makes the tag with a release that is not a draft.
      if (!r.draft && !this.tags.has(tag)) this.tags.set(tag, { sha: r.target_commitish });
      this.releases.push(r);
      return { ok: true, value: { ...r } };
    }
    const m = /^repos\/o\/r\/releases\/(\d+)$/.exec(endpoint);
    if (m) {
      const at = this.releases.findIndex((x) => x.id === Number(m[1]));
      if (at < 0) return NOT_FOUND;
      const r = this.releases[at];
      if (method === 'DELETE') {
        this.releases.splice(at, 1);
        return { ok: true, value: null };
      }
      // The fields the request names, as GitHub takes them.
      if (typeof body.tag_name === 'string') r.tag_name = body.tag_name;
      if (typeof body.target_commitish === 'string') r.target_commitish = body.target_commitish;
      if (typeof body.name === 'string') r.name = body.name;
      if (typeof body.body === 'string') r.body = body.body;
      if (typeof body.prerelease === 'boolean') r.prerelease = body.prerelease;
      if (body.draft === false && r.draft) {
        // Publishing makes the tag at the target, or takes the tag as it is.
        if (!this.tags.has(r.tag_name)) this.tags.set(r.tag_name, { sha: r.target_commitish });
        r.draft = false;
      }
      return { ok: true, value: { ...r } };
    }
    return null;
  }

  async write(_host: string, method: GhActMethod, endpoint: string, body: Record<string, unknown>): Promise<GhActAnswer> {
    const w = { method, endpoint, body };
    this.writes.push(w);
    this.onWrite?.(w);
    const forced = this.nextWrite;
    this.nextWrite = null;
    const apply = (): GhActAnswer => {
      const release = this.writeRelease(method, endpoint, body);
      if (release) return release;
      let m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(endpoint);
      if (method === 'POST' && m) {
        const c: FakeComment = { id: this.nextId++, issue: Number(m[1]), body: String(body.body), user: { login: this.login }, html_url: `https://github.com/o/r/issues/${m[1]}#issuecomment-${this.nextId}` };
        this.comments.push(c);
        return { ok: true, value: c };
      }
      if (method === 'POST' && endpoint === 'repos/o/r/issues') {
        const n = this.nextId++;
        const i = this.addIssue(n, { title: String(body.title), body: String(body.body), user: { login: this.login } });
        return { ok: true, value: i };
      }
      m = /^repos\/o\/r\/(issues|pulls)\/(\d+)$/.exec(endpoint);
      if (method === 'PATCH' && m) {
        const i = this.issues.get(Number(m[2]));
        if (!i) return { ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' };
        i.state = 'closed';
        i.closed_by = { login: this.login };
        i.closed_at = new Date(Date.now()).toISOString();
        i.state_reason = m[1] === 'issues' && typeof body.state_reason === 'string' ? body.state_reason : null;
        return { ok: true, value: m[1] === 'pulls' ? this.pullJson(i.number) : i };
      }
      return { ok: false, kind: 'http', status: 404, message: 'gh: Not Found (HTTP 404)' };
    };
    if (forced) {
      if (forced.landed) apply();
      return forced.answer;
    }
    return apply();
  }
}
