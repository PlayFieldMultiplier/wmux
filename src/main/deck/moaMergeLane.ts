// ─── Moa's merge lane — the predicates a merge must pass (pure) ──────────────
//
// A lane-only evaluator, separate from prReview.mergeBlock (which stays the Git
// page's rule and still runs inside GhPrReviewService.merge). Before ANY merge
// execution — the first try and every retry or replay — the executor:
//   1. reads PrLaneFacts fresh (MergeLaneFactsReader: LANE_PR_QUERY, no cache);
//   2. runs evaluateMergeLane on them (every predicate for a 'moa-auto'
//      effect; head-unchanged only for one the owner approved);
//   3. calls GhPrReviewService.merge with expectHead, which re-reads the head,
//      applies mergeBlock and passes --match-head-commit.
// A stored verdict is never a reason to merge. Every predicate fails closed:
// a list that may be incomplete (truncated files, checks or labels) blocks.
//
// Decided from the changed-files list, never from a title or labels alone:
//   not-release-pr   package.json / package-lock.json (a version bump and a
//                    dependency change are indistinguishable by path, and both
//                    go to the owner), CHANGELOG.md (changelog.d/ fragments are
//                    fine), .github/, release and notice scripts, packaging.
//   gate-definition-changed  the files that define the gate a verifier runs
//                    (scripts/verify.sh, package.json, .npmrc, wmux.json,
//                    vitest, eslint and tsconfig files): a PR that changes them is
//                    not graded by its own gate without the owner. A
//                    package.json change also fails not-release-pr; each
//                    predicate reports its own reason.
//   not-windows-path path tokens naming Windows (win32, windows, wsl, conpty,
//                    squirrel, pwsh, …), Windows-only trees and extensions.
// Path tokens split on separators AND camelCase, so `winSnapshotNative.ts`
// counts; an Electron `auxiliaryWindows.ts` also counts — over-firing only
// sends a merge to the owner.
//
// Decided from the verdict store (shared/prVerdict.ts), read fresh by main:
//   verifier-pass-at-head  a workspace other than the PR's authors (for a
//                    bot's PASS with `authorBots` known: a bot other than the
//                    ones that dispatched the PR's worker) recorded
//                    PASS at exactly the head being merged, and nobody
//                    recorded FAIL there. With `botVerdictsOnly` (the factory
//                    is on) a PASS counts only when its evidence resolves to a
//                    bot verify task whose system gate ran, unskipped and
//                    green, on a detached checkout of that head
//                    (verdictEvidenceCheck). Two cases rest on no gate run,
//                    because no gate grades them: a gate recorded as
//                    `no_gate_command` (the repository declares no gate on
//                    its base, which the gate runner reads itself), and a
//                    reading-only verdict main recorded for a docs-only
//                    change (re-checked here on this read's file list) or
//                    for a repository it found declaring no gate. Any other
//                    skip still refuses.

import type { LedgerGateResult } from '../../shared/ledger';
import type { PrLaneFacts } from '../../shared/prReview';
import type { PrVerdictRecord } from '../../shared/prVerdict';
import { isDocsOnlyChange } from '../../shared/docsChange';

export type LanePredicate =
  | 'head-unchanged'
  | 'required-checks-green'
  | 'not-release-pr'
  | 'gate-definition-changed'
  | 'not-windows-path'
  | 'no-needs-windows-verify-label'
  | 'author-trusted'
  | 'pr-branch-bound-to-asker'
  | 'verifier-pass-at-head';

/** Evaluation order, and every predicate a 'moa-auto' or 'lane' merge must
 *  pass. */
export const LANE_PREDICATES: readonly LanePredicate[] = [
  'head-unchanged',
  'required-checks-green',
  'not-release-pr',
  'gate-definition-changed',
  'not-windows-path',
  'no-needs-windows-verify-label',
  'author-trusted',
  'pr-branch-bound-to-asker',
  'verifier-pass-at-head',
];

/** What an owner-approved merge re-checks (mergeBlock runs inside merge()). */
export const OWNER_APPROVED_PREDICATES: readonly LanePredicate[] = ['head-unchanged'];

export const NEEDS_WINDOWS_VERIFY_LABEL = 'needs-windows-verify';

export interface LaneFailure {
  predicate: LanePredicate;
  /** A short kebab-case code. */
  reason: string;
}

export type LaneCheck = { ok: true } | { ok: false; reason: string };

export interface MergeLaneContext {
  /** The head the decision was about. */
  expectHead: string;
  /** Lowercase logins allowed without the owner: MoaConfig.trustedAuthors plus
   *  the owner's own login, read by main. */
  trustedAuthors: readonly string[];
  /** Branches bound to the asker, read by main: the branch checked out in the
   *  asker's cwd and the branches of its task ledger rows. */
  askerBranches: readonly string[];
  /** This PR's verdict records, read fresh by main; null when unreadable. */
  verdicts: readonly PrVerdictRecord[] | null;
  /** The workspaces that authored the PR, read by main: the asker, the
   *  workspaces of tasks on the head branch, and those with a pane in a
   *  worktree of it. Null when any part could not be read. */
  authorWorkspaces: readonly string[] | null;
  /** The bots whose fan-out produced the PR's head branch (their ledger rows'
   *  dispatch origin), read by main. When set, a bot's PASS is self-verified
   *  only when its bot is one of these — a verifier may share a workspace
   *  with the lead that dispatched the PR's worker. A PASS without a bot
   *  (a pane verifier) is judged by `authorWorkspaces` as before. Absent:
   *  every PASS is judged by workspace. */
  authorBots?: readonly string[] | null;
  /** True when the factory is on: a PASS counts only with evidence that
   *  resolves in `evidenceRows` (verdictEvidenceCheck). Absent/false keeps
   *  the stage-2 rule (any non-author PASS at the head). */
  botVerdictsOnly?: boolean;
  /** The ledger rows behind the verdicts' `evidence.taskId`, resolved by the
   *  caller from main's own stores, keyed by task id. A task the caller could
   *  not find is left out; null/absent when the rows could not be read, which
   *  under `botVerdictsOnly` refuses. */
  evidenceRows?: ReadonlyMap<string, LaneEvidenceRow> | null;
}

/** A verify task's ledger row as the lane needs it: who dispatched it, with
 *  which preset, on what checkout, and the gate the runner recorded. */
export interface LaneEvidenceRow {
  taskId: string;
  /** Who started the task; only `{kind: 'bot', botId}` can back a verdict. */
  origin: { kind: string; botId?: string };
  /** The fan-out preset, e.g. 'verify'; null when none. */
  preset: string | null;
  /** The task worktree's checkout; null when it was a branch checkout. */
  checkout: { sha: string; detached: boolean } | null;
  /** The system-recorded gate result, null when none was recorded. */
  gate: LedgerGateResult | null;
}

/** The verifier a passing `verifier-pass-at-head` rests on. */
export interface LaneVerifier {
  workspaceId: string;
  agent: string;
  headSha: string;
  /** Set when the PASS came from a bot with evidence (botVerdictsOnly). */
  botId?: string;
  taskId?: string;
}

export interface LaneVerdict {
  ok: boolean;
  /** Every failed predicate, in LANE_PREDICATES order. */
  failures: LaneFailure[];
  /** Set when verifier-pass-at-head ran and passed. */
  verifiedBy?: LaneVerifier;
}

/** The gh I/O half (built later). Must read fresh: never a cached answer. */
export interface MergeLaneFactsReader {
  readFresh(repoPath: string, repoKey: string, prNumber: number): Promise<PrLaneFacts>;
}

const pass: LaneCheck = { ok: true };
const fail = (reason: string): LaneCheck => ({ ok: false, reason });

export function headUnchanged(facts: PrLaneFacts, expectHead: string): LaneCheck {
  return facts.headRefOid === expectHead ? pass : fail('head-moved');
}

/**
 * Every check the base branch requires is green on `headSha`. An EMPTY
 * required set blocks: no protection means nothing proves the PR is safe.
 * `pass` only; a skipped required check blocks too.
 */
export function requiredChecksGreen(facts: PrLaneFacts, headSha: string): LaneCheck {
  if (facts.headRefOid !== headSha || facts.checksHeadOid !== headSha) return fail('checks-not-on-head');
  if (facts.checksTruncated) return fail('checks-truncated');
  const required = facts.checks.filter((c) => c.isRequired === true);
  if (required.length === 0) return fail('no-required-checks');
  const notGreen = required.find((c) => c.bucket !== 'pass');
  if (!notGreen) return pass;
  return fail(notGreen.bucket === 'pending' ? 'required-check-pending' : `required-check-${notGreen.bucket}`);
}

/** Release, CI and dependency paths: [reason, test]. Paths are repo-relative. */
const RELEASE_PATHS: ReadonlyArray<[string, (p: string) => boolean]> = [
  ['package-manifest', (p) => /(?:^|\/)package(?:-lock)?\.json$/.test(p)],
  ['dependency-patch', (p) => p.startsWith('patches/')],
  ['build-config', (p) => p.startsWith('build/')],
  ['changelog', (p) => p === 'CHANGELOG.md'],
  ['ci-config', (p) => p.startsWith('.github/')],
  ['release-script', (p) => /^scripts\/(?:collect-changelog|gen-api-reference|generate-notices|release[^/]*)\.[cm]?[jt]s$/.test(p)],
  ['packaging', (p) => p === 'forge.config.ts' || p.startsWith('chocolatey/') || p === 'install.ps1'],
  ['license', (p) => p === 'LICENSE' || p === 'THIRD_PARTY_NOTICES' || p === 'license-allowlist.json'],
];

/** The release reason a changed path falls under, or null. */
export function releasePathReason(path: string): string | null {
  for (const [reason, test] of RELEASE_PATHS) if (test(path)) return reason;
  return null;
}

export function notReleasePr(facts: PrLaneFacts): LaneCheck {
  if (facts.filesTruncated) return fail('files-truncated');
  if (facts.files.length === 0) return fail('no-files');
  for (const p of facts.files) {
    const reason = releasePathReason(p);
    if (reason) return fail(reason);
  }
  return pass;
}

/** Files that define the gate a verifier runs: [reason, test]. */
const GATE_DEFINITION_PATHS: ReadonlyArray<[string, (p: string) => boolean]> = [
  ['verify-script', (p) => p === 'scripts/verify.sh'],
  ['package-manifest', (p) => /(?:^|\/)package\.json$/.test(p)],
  ['npm-config', (p) => /(?:^|\/)\.npmrc$/.test(p)],
  ['project-config', (p) => /(?:^|\/)wmux\.json$/.test(p)],
  ['test-config', (p) => /(?:^|\/)vitest(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/.test(p) || /(?:^|\/)vitest\.workspace\.[\w.]+$/.test(p)],
  ['lint-config', (p) => /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[\w]+)?|\.eslintignore)$/.test(p)],
  ['ts-config', (p) => /(?:^|\/)tsconfig[^/]*\.json$/.test(p)],
];

/** The gate-definition reason a changed path falls under, or null. */
export function gateDefinitionPathReason(path: string): string | null {
  for (const [reason, test] of GATE_DEFINITION_PATHS) if (test(path)) return reason;
  return null;
}

export function gateDefinitionUnchanged(facts: PrLaneFacts): LaneCheck {
  if (facts.filesTruncated) return fail('files-truncated');
  if (facts.files.length === 0) return fail('no-files');
  for (const p of facts.files) {
    const reason = gateDefinitionPathReason(p);
    if (reason) return fail(reason);
  }
  return pass;
}

const WINDOWS_TOKENS: ReadonlySet<string> = new Set([
  'win', 'win32', 'win64', 'windows', 'wsl', 'conpty', 'winpty', 'squirrel', 'pwsh', 'powershell',
  'winget', 'chocolatey', 'choco', 'nsis', 'msi', 'msix', 'appx',
]);
const WINDOWS_EXTENSIONS = /\.(?:ps1|psm1|psd1|bat|cmd|nsi|nuspec|msi|reg)$/i;
const WINDOWS_TREES = ['native/computer-use-windows/', 'chocolatey/'];

/** Lowercase tokens of a path, split on separators and camelCase. */
export function pathTokens(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s/\\._-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export function isWindowsPath(path: string): boolean {
  if (WINDOWS_TREES.some((t) => path.startsWith(t)) || path === 'install.ps1') return true;
  if (WINDOWS_EXTENSIONS.test(path)) return true;
  return pathTokens(path).some((t) => WINDOWS_TOKENS.has(t));
}

export function notWindowsPath(facts: PrLaneFacts): LaneCheck {
  if (facts.filesTruncated) return fail('files-truncated');
  return facts.files.some(isWindowsPath) ? fail('windows-path') : pass;
}

export function noNeedsWindowsVerifyLabel(facts: PrLaneFacts): LaneCheck {
  if (facts.labelsTruncated) return fail('labels-truncated');
  return facts.labels.some((l) => l.toLowerCase() === NEEDS_WINDOWS_VERIFY_LABEL) ? fail('needs-windows-verify') : pass;
}

export function authorTrusted(facts: PrLaneFacts, trustedAuthors: readonly string[]): LaneCheck {
  if (!facts.author) return fail('no-author');
  return trustedAuthors.includes(facts.author.toLowerCase()) ? pass : fail('external-author');
}

/** The head branch is one bound to the asker, and lives in this repo (a fork's
 *  branch can carry any name). */
export function prBranchBoundToAsker(facts: PrLaneFacts, askerBranches: readonly string[]): LaneCheck {
  if (facts.isCrossRepository) return fail('cross-repository');
  if (!facts.headRefName) return fail('no-head-branch');
  return askerBranches.includes(facts.headRefName) ? pass : fail('branch-not-bound');
}

/** Whether the PR's changed files, as this read lists them, are docs-only:
 *  the whole list read and no rename or copy among them (a rename lists
 *  only its new path, so the code it moved would be unseen). */
export function laneDocsOnly(facts: Pick<PrLaneFacts, 'files' | 'filesTruncated' | 'filesRenamed'>): boolean {
  return isDocsOnlyChange(facts.files, facts.filesTruncated || facts.filesRenamed !== false);
}

/**
 * Whether one PASS is backed by main-written evidence (botVerdictsOnly). The
 * verdict names its task; the row the caller resolved for that task must be a
 * bot's `verify` task, dispatched by the verdict's own bot, on a detached
 * checkout of the verdict's head, whose system-recorded gate ran on that head
 * and exited 0 without being a skip, or was the `no_gate_command` record
 * (the repository declares no gate on its base, so there is nothing to run).
 * A reading-only verdict (evidence.reading) rests on no task: `docs-only`
 * counts only while `facts` (this read of the PR) still shows a docs-only
 * change; `no-gate` is main's finding when it recorded the verdict, the same
 * finding a `no_gate_command` record carries. Null = counts.
 */
export function verdictEvidenceCheck(
  r: PrVerdictRecord,
  rows: ReadonlyMap<string, LaneEvidenceRow>,
  facts?: Pick<PrLaneFacts, 'files' | 'filesTruncated' | 'filesRenamed'>,
): 'verdict-no-evidence' | 'evidence-mismatch' | 'gate-skipped' | 'gate-failed' | 'gate-required' | null {
  const ev = r.evidence;
  if (!ev) return 'verdict-no-evidence';
  const botId = r.principal.botId;
  if (ev.reading !== undefined) {
    if (!botId || ev.gateHeadSha !== r.headSha) return 'evidence-mismatch';
    if (ev.reading === 'no-gate') return null;
    return facts && laneDocsOnly(facts) ? null : 'gate-required';
  }
  const row = rows.get(ev.taskId);
  if (!row || row.taskId !== ev.taskId || !botId) return 'evidence-mismatch';
  if (row.origin.kind !== 'bot' || row.origin.botId !== botId) return 'evidence-mismatch';
  if (row.preset !== 'verify') return 'evidence-mismatch';
  if (!row.checkout || row.checkout.detached !== true || row.checkout.sha !== r.headSha) return 'evidence-mismatch';
  if (ev.gateHeadSha !== r.headSha) return 'evidence-mismatch';
  const gate = row.gate;
  if (!gate || gate.recordedBy !== 'system') return 'evidence-mismatch';
  // No gate declared: the runner recorded that it had nothing to run. That
  // is the repository's whole gate, so it stands in for a green one.
  const noGate = gate.skipped === 'no_gate_command' && gate.command === 'none' && gate.exitCode === 0;
  // Any other recorded skip ran nothing: it is not a pass, whatever its exit code.
  if (!noGate && (gate.skipped !== undefined || gate.command === 'none')) return 'gate-skipped';
  if (gate.headSha !== r.headSha) return 'evidence-mismatch';
  if (gate.exitCode !== 0) return 'gate-failed';
  return null;
}

/** Most specific first, for the reason a set of PASSes all failed. */
const EVIDENCE_REASON_RANK: readonly string[] = ['gate-failed', 'gate-required', 'gate-skipped', 'evidence-mismatch', 'verdict-no-evidence'];

/**
 * A PASS at exactly `expectHead` from a workspace that is not one of the PR's
 * authors, and no FAIL there from anyone. This guards against an author
 * verifying its own work. With `botVerdictsOnly`, the PASS must also pass
 * verdictEvidenceCheck; a FAIL from anyone still blocks.
 */
export function verifierPassAtHead(facts: PrLaneFacts, ctx: MergeLaneContext): { check: LaneCheck; by?: LaneVerifier } {
  if (ctx.verdicts === null) return { check: fail('verdicts-unreadable') };
  if (ctx.authorWorkspaces === null) return { check: fail('author-unknown') };
  const forPr = ctx.verdicts.filter((r) => r.prNumber === facts.number);
  const atHead = facts.headRefOid === ctx.expectHead ? forPr.filter((r) => r.headSha === ctx.expectHead) : [];
  if (atHead.some((r) => r.verdict === 'fail')) return { check: fail('verdict-fail') };
  if (atHead.length === 0) return { check: fail(forPr.length > 0 ? 'verdict-stale-head' : 'no-verdict') };
  const authors = ctx.authorWorkspaces;
  const authorBots = ctx.authorBots;
  const isAuthor = (r: PrVerdictRecord): boolean => (r.principal.botId && authorBots
    ? authorBots.includes(r.principal.botId)
    : authors.includes(r.principal.workspaceId));
  const passes = atHead.filter((r) => r.verdict === 'pass' && !isAuthor(r));
  if (passes.length === 0) return { check: fail('self-verified') };
  if (!ctx.botVerdictsOnly) {
    const p = passes[0];
    return { check: { ok: true }, by: { workspaceId: p.principal.workspaceId, agent: p.principal.agent, headSha: p.headSha } };
  }
  const rows = ctx.evidenceRows;
  if (!rows) return { check: fail('evidence-unreadable') };
  let worst: number = EVIDENCE_REASON_RANK.length;
  for (const p of passes) {
    const why = verdictEvidenceCheck(p, rows, facts);
    if (why === null) {
      return {
        check: { ok: true },
        by: {
          workspaceId: p.principal.workspaceId, agent: p.principal.agent, headSha: p.headSha,
          ...(p.principal.botId ? { botId: p.principal.botId } : {}),
          ...(p.evidence && p.evidence.reading === undefined ? { taskId: p.evidence.taskId } : {}),
        },
      };
    }
    worst = Math.min(worst, EVIDENCE_REASON_RANK.indexOf(why));
  }
  return { check: fail(EVIDENCE_REASON_RANK[worst] ?? 'verdict-no-evidence') };
}

function runPredicate(p: LanePredicate, facts: PrLaneFacts, ctx: MergeLaneContext): LaneCheck {
  switch (p) {
    case 'head-unchanged': return headUnchanged(facts, ctx.expectHead);
    case 'required-checks-green': return requiredChecksGreen(facts, ctx.expectHead);
    case 'not-release-pr': return notReleasePr(facts);
    case 'gate-definition-changed': return gateDefinitionUnchanged(facts);
    case 'not-windows-path': return notWindowsPath(facts);
    case 'no-needs-windows-verify-label': return noNeedsWindowsVerifyLabel(facts);
    case 'author-trusted': return authorTrusted(facts, ctx.trustedAuthors);
    case 'pr-branch-bound-to-asker': return prBranchBoundToAsker(facts, ctx.askerBranches);
    case 'verifier-pass-at-head': return verifierPassAtHead(facts, ctx).check;
  }
}

/** Run `predicates` (default: all) on one fresh read. Pure. */
export function evaluateMergeLane(
  facts: PrLaneFacts,
  ctx: MergeLaneContext,
  predicates: readonly LanePredicate[] = LANE_PREDICATES,
): LaneVerdict {
  const failures: LaneFailure[] = [];
  for (const p of LANE_PREDICATES) {
    if (!predicates.includes(p)) continue;
    const r = runPredicate(p, facts, ctx);
    if (!r.ok) failures.push({ predicate: p, reason: r.reason });
  }
  const verifiedBy = predicates.includes('verifier-pass-at-head') ? verifierPassAtHead(facts, ctx).by : undefined;
  return { ok: failures.length === 0, failures, ...(verifiedBy ? { verifiedBy } : {}) };
}
