// A small in-memory GitHub for the act executor's tests: the answers of the
// endpoints actExecutor.ts reads and writes, shaped like GitHub's REST.

import type { GhActAnswer, GhActPort } from '../../github/GhActService';

export interface FakeIssue {
  number: number;
  node_id: string;
  title: string;
  state: 'open' | 'closed';
  locked?: boolean;
  pull_request?: Record<string, unknown>;
  closed_by?: { login: string } | null;
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

export class FakeGithub implements GhActPort {
  login = 'owner';
  repo = { full_name: 'o/r', node_id: 'R_1', id: 4242 };
  issues = new Map<number, FakeIssue>();
  pulls = new Map<number, { head: string; merged: boolean }>();
  comments: FakeComment[] = [];
  writes: Array<{ method: string; endpoint: string; body: Record<string, unknown> }> = [];
  reads: string[] = [];
  /** Replace the next write's answer (a timeout, a wrong shape, …);
   *  `landed`: GitHub took the write all the same. */
  nextWrite: { answer: GhActAnswer; landed: boolean } | null = null;
  /** Called on every read (a test may change state mid-run). */
  onRead: ((endpoint: string) => void) | null = null;
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
    const path = endpoint.split('?')[0];
    const query = new URLSearchParams(endpoint.split('?')[1] ?? '');
    if (path === 'user') return { ok: true, value: { login: this.login } };
    if (path === 'repos/o/r') return { ok: true, value: this.repo };
    let m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
    if (m) return { ok: true, value: this.comments.filter((c) => c.issue === Number(m?.[1])) };
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
      return { ok: true, value: [...this.issues.values()].filter((i) => !creator || i.user.login === creator) };
    }
    return { ok: false, kind: 'http', status: 404, message: `gh: no such endpoint ${endpoint} (HTTP 404)` };
  }

  async write(_host: string, method: 'POST' | 'PATCH', endpoint: string, body: Record<string, unknown>): Promise<GhActAnswer> {
    const w = { method, endpoint, body };
    this.writes.push(w);
    const forced = this.nextWrite;
    this.nextWrite = null;
    const apply = (): GhActAnswer => {
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
