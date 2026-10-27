// Where a commit made in a wmux pane came from, recorded locally by the daemon
// (daemon/commitOrigin) so a later view can open the conversation that made
// it. Nothing is written into the repository.
//
// A link is made only on evidence: git's own summary line for the commit
// (`[branch abc1234] …`) in that pane's output. A wrong link would send someone
// to the wrong conversation, so a pane that was merely the only one in the
// worktree is a candidate, never the attribution.

export const COMMIT_ORIGIN_SCHEMA = 1 as const;

/** What the reflog line says happened. */
export type CommitOriginOp = 'commit' | 'amend' | 'initial';

/** How sure the record is. */
export type CommitOriginEvidence =
  /** git's summary line for it showed in the attributed pane's output, and in no other pane's. */
  | 'screen'
  /** No pane showed it; it was the only pane in that worktree. A candidate, not an attribution. */
  | 'only-pane'
  /** No pane showed it, and several were in that worktree. */
  | 'none';

/** One pane, as it was the moment the commit landed. */
export interface CommitOriginPane {
  ptyId: string;
  workspaceId: string | null;
  /** The agent the pane ran (registry slug), or null for a plain shell. */
  agent: string | null;
  /** The agent's own session id at that moment, or null when not known. */
  agentSessionId: string | null;
}

export interface CommitOrigin {
  /** Full commit id (SHA-1 or SHA-256). */
  sha: string;
  /** When the commit landed (the reflog time), ms. */
  at: number;
  op: CommitOriginOp;
  /** The branch checked out, or null when detached or not known. */
  branch: string | null;
  evidence: CommitOriginEvidence;
  /** Set only on 'screen' evidence. */
  attributed?: CommitOriginPane & { taskId: string | null };
  /** Without 'screen' evidence: the panes in that worktree when it landed. */
  candidates?: CommitOriginPane[];
}

export const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** git never abbreviates below this. */
export const MIN_ABBREV = 7;
/** At most this many candidate panes are kept with a record. */
export const COMMIT_ORIGIN_MAX_CANDIDATES = 8;

export interface ReflogCommit {
  sha: string;
  /** ms */
  at: number;
  op: CommitOriginOp;
}

/**
 * One `logs/HEAD` line, when it records a commit made in this worktree:
 * `<old> <new> <name> <<email>> <seconds> <tz>\t<op>: <subject>`. The subject
 * is used only to tell the kind of commit apart and is never kept. Other
 * entries (checkout, reset, rebase, merge, cherry-pick, pull) are null.
 */
export function parseReflogCommit(line: string): ReflogCommit | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const head = line.slice(0, tab);
  const what = line.slice(tab + 1);
  const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) .* (\d{1,12}) [+-]\d{4}$/.exec(head);
  if (!m) return null;
  let op: CommitOriginOp;
  if (what.startsWith('commit: ')) op = 'commit';
  else if (what.startsWith('commit (amend): ')) op = 'amend';
  else if (what.startsWith('commit (initial): ')) op = 'initial';
  else return null;
  return { sha: m[2], at: Number(m[3]) * 1000, op };
}

/**
 * git's summary line for the commit `sha` in some text, the one `git commit`
 * prints: `[main abc1234] …`, `[main (root-commit) abc1234] …` or
 * `[detached HEAD abc1234] …`. Its branch (null when detached), or undefined
 * when the text does not show it. A bare hash (a prompt, `git log`) is not it.
 */
export function commitSummaryIn(text: string, sha: string): { branch: string | null } | undefined {
  const re = /\[(detached HEAD|[^\s[\]]+)(?: \(root-commit\))? ([0-9a-f]{7,64})\]/g;
  for (const m of text.matchAll(re)) {
    const abbrev = m[2];
    if (abbrev.length >= MIN_ABBREV && sha.startsWith(abbrev)) return { branch: m[1] === 'detached HEAD' ? null : m[1] };
  }
  return undefined;
}

function pane(raw: unknown): CommitOriginPane | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const ptyId = str(r.ptyId);
  return ptyId ? { ptyId, workspaceId: str(r.workspaceId), agent: str(r.agent, 64), agentSessionId: str(r.agentSessionId) } : null;
}

/** A stored record, or null when it is not one. */
export function parseCommitOrigin(raw: unknown): CommitOrigin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sha !== 'string' || !SHA_RE.test(r.sha)) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < 0) return null;
  if (r.op !== 'commit' && r.op !== 'amend' && r.op !== 'initial') return null;
  if (r.evidence !== 'screen' && r.evidence !== 'only-pane' && r.evidence !== 'none') return null;
  const branch = typeof r.branch === 'string' && r.branch.length > 0 && r.branch.length <= 256 ? r.branch : null;
  const out: CommitOrigin = { sha: r.sha, at: r.at, op: r.op, branch, evidence: r.evidence };
  if (r.evidence === 'screen') {
    const a = pane(r.attributed);
    if (!a) return null;
    const taskId = (r.attributed as Record<string, unknown>).taskId;
    out.attributed = { ...a, taskId: typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 200 ? taskId : null };
  } else {
    out.candidates = (Array.isArray(r.candidates) ? r.candidates : []).slice(0, COMMIT_ORIGIN_MAX_CANDIDATES).map(pane).filter((p): p is CommitOriginPane => p !== null);
  }
  return out;
}
