// Merge-lane graders: the verifier's verdict bound to main-recorded evidence
// at the PR head, the lane's fail-closed refusal or ready card, a moved head,
// and the repo watch's first-poll baseline.

import { arr, botId, cardsOfKind, criterion, factsOfKind, wakesOf } from './common.mjs';

function pr(snap, n) {
  return arr(snap.gh?.state?.repos?.['github.com/acme/app']?.prs).find((p) => p.number === n) ?? null;
}

/** Verdict + evidence criteria shared by the lane scenarios, for one head. */
function verdictCriteria(snap, verifierKey, prNumber, head, suffix = '') {
  const vid = botId(snap, verifierKey);
  const facts = factsOfKind(snap, 'verdict.recorded').filter((f) => f.ref?.pr === prNumber && f.ref?.headSha === head);
  const recs = arr(snap.verdicts).filter((v) => v.prNumber === prNumber && v.headSha === head);
  const rec = recs.find((v) => v.principal?.botId === vid) ?? null;
  const row = rec?.evidence?.taskId ? arr(snap.ledger).find((e) => e.id === rec.evidence.taskId) ?? null : null;
  return [
    criterion(`verdict_fact${suffix}`, facts.length === 1 && facts[0].ref?.botId === vid, `${facts.length} verdict.recorded fact(s) at ${String(head).slice(0, 7)}`),
    criterion(`verdict_by_verifier_bot${suffix}`, !!rec && rec.version === 2 && rec.verdict === 'pass', rec ? `v${rec.version} ${rec.verdict} by ${rec.principal?.botId}` : `${recs.length} record(s), none by the verifier`),
    criterion(`evidence_gate_at_head${suffix}`, !!rec && rec.evidence?.gateHeadSha === head, `gateHeadSha ${rec?.evidence?.gateHeadSha ?? 'none'}`),
    criterion(`evidence_is_verify_task${suffix}`, !!row && row.dispatch?.origin?.botId === vid && row.dispatch?.preset === 'verify'
      && row.dispatch?.checkout?.detached === true && row.dispatch?.checkout?.sha === head,
    row ? `${row.id} preset ${row.dispatch?.preset} checkout ${row.dispatch?.checkout?.sha?.slice(0, 7)}` : 'no ledger row'),
    criterion(`gate_recorded_by_system${suffix}`, !!row && row.gate?.exitCode === 0 && row.gate?.headSha === head && !row.gate?.skipped,
      row?.gate ? `exit ${row.gate.exitCode} head ${row.gate.headSha?.slice(0, 7)} ${row.gate.skipped ?? ''}` : 'no gate'),
  ];
}

/** 15. verifier-lane-fail-closed. */
export function verifierLaneFailClosed(snap, expect) {
  const n = expect.pr ?? 1;
  const head = snap.saved?.[`pr${n}Head`];
  const refused = factsOfKind(snap, 'merge.refused').filter((f) => f.ref?.pr === n && f.ref?.headSha === head);
  const owner = arr(snap.records).find((r) => r.label === 'owner-merge');
  const merges = arr(snap.gh?.calls).filter((c) => c.argv?.[0] === 'pr' && c.argv?.[1] === 'merge');
  const ownerAt = arr(snap.actions).find((a) => a.label === 'owner-merge')?.at ?? Infinity;
  return [
    ...verdictCriteria(snap, expect.verifier, n, head),
    criterion('lane_refused_fail_closed', refused.length === 1 && String(refused[0].payload?.reason ?? '').includes(expect.laneReason), refused.map((f) => f.payload?.reason).join(' | ') || 'no merge.refused'),
    criterion('refusal_in_pr_thread', arr(snap.cards).some((c) => c.threadId === `pr:github.com/acme/app#${n}` && /refused/i.test(c.title)), 'merge.refused card in the PR thread'),
    criterion('lane_merged_nothing', merges.every((c) => c.at >= ownerAt), `${merges.filter((c) => c.at < ownerAt).length} merge call(s) before the owner's`),
    criterion('owner_merge_went_through', owner?.result?.ok === true && pr(snap, n)?.state === 'MERGED', `owner merge ${JSON.stringify(owner?.result ?? null).slice(0, 120)}; PR ${pr(snap, n)?.state ?? '-'}`),
    criterion('merged_fact', factsOfKind(snap, 'pr.merged').some((f) => f.ref?.pr === n), `${factsOfKind(snap, 'pr.merged').length} pr.merged fact(s)`),
  ];
}

/** lane-ready-card: every predicate passes, auto-merge off → a ready card, no merge. */
export function laneReadyCard(snap, expect) {
  const n = expect.pr ?? 1;
  const head = snap.saved?.[`pr${n}Head`];
  const ready = cardsOfKind(snap, 'status').filter((c) => c.actor?.kind === 'system' && c.threadId === `pr:github.com/acme/app#${n}` && /ready to merge/i.test(c.title));
  const refused = factsOfKind(snap, 'merge.refused').filter((f) => f.ref?.pr === n);
  const merges = arr(snap.gh?.calls).filter((c) => c.argv?.[0] === 'pr' && c.argv?.[1] === 'merge');
  return [
    ...verdictCriteria(snap, expect.verifier, n, head),
    criterion('ready_card_in_pr_thread', ready.length === 1 && ready[0].title.includes(String(head).slice(0, 7)), ready.map((c) => c.title).join(' | ') || 'none'),
    criterion('not_refused', refused.length === 0, refused.map((f) => f.payload?.reason).join(' | ') || 'none'),
    criterion('auto_merge_off_merged_nothing', merges.length === 0 && pr(snap, n)?.state === 'OPEN' && arr(snap.effects).every((e) => e.approvedBy !== 'lane' || e.status !== 'done'), `${merges.length} merge call(s); PR ${pr(snap, n)?.state ?? '-'}`),
  ];
}

/** reviewer-reads-docs-no-worker: a reading-only PASS on a change no gate
 *  grades, recorded with no verify worker, counted by the lane. */
export function reviewerReadsNoWorker(snap, expect) {
  const n = expect.pr ?? 1;
  const head = snap.saved?.[`pr${n}Head`];
  const vid = botId(snap, expect.verifier);
  const facts = factsOfKind(snap, 'verdict.recorded').filter((f) => f.ref?.pr === n && f.ref?.headSha === head);
  const rec = arr(snap.verdicts).find((v) => v.prNumber === n && v.headSha === head && v.principal?.botId === vid) ?? null;
  const verifierTasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === vid);
  const installs = arr(snap.workers).filter((e) => e.event === 'deps');
  const ready = cardsOfKind(snap, 'status').filter((c) => c.actor?.kind === 'system' && c.threadId === `pr:github.com/acme/app#${n}` && /ready to merge/i.test(c.title));
  const refused = factsOfKind(snap, 'merge.refused').filter((f) => f.ref?.pr === n);
  const opened = factsOfKind(snap, 'pr.opened').find((f) => f.ref?.pr === n);
  const took = opened && facts[0] ? `${Math.round((facts[0].at - opened.at) / 100) / 10}s from pr.opened to the verdict` : 'no timing';
  return [
    criterion('verdict_fact', facts.length === 1 && facts[0].ref?.botId === vid, `${facts.length} verdict.recorded fact(s) at ${String(head).slice(0, 7)}; ${took}`),
    criterion('reading_only_pass', !!rec && rec.version === 2 && rec.verdict === 'pass' && rec.evidence?.reading === expect.reading && rec.evidence?.gateHeadSha === head
      // Bound to the base commit the forge reported for the PR.
      && rec.evidence?.baseRef === 'origin/main' && !!snap.saved?.[`pr${n}Base`] && rec.evidence?.baseSha === snap.saved?.[`pr${n}Base`],
      rec ? `${rec.verdict}, evidence ${JSON.stringify(rec.evidence)}` : 'no verdict by the verifier'),
    criterion('no_verify_worker', verifierTasks.length === 0 && installs.length === 0, `${verifierTasks.length} task(s) by the verifier, ${installs.length} install(s)`),
    criterion('ready_card_in_pr_thread', ready.length === 1 && ready[0].title.includes(String(head).slice(0, 7)), ready.map((c) => c.title).join(' | ') || 'none'),
    criterion('not_refused', refused.length === 0, refused.map((f) => f.payload?.reason).join(' | ') || 'none'),
  ];
}

/** 16. stale-head-reverify. */
export function staleHeadReverify(snap, expect) {
  const n = expect.pr ?? 1;
  const moved = factsOfKind(snap, 'pr.head_moved').filter((f) => f.ref?.pr === n);
  const head2 = moved[0]?.ref?.headSha ?? null;
  const verdicts = factsOfKind(snap, 'verdict.recorded').filter((f) => f.ref?.pr === n);
  const head1 = verdicts.find((f) => f.ref?.headSha !== head2)?.ref?.headSha ?? null;
  const v2 = verdicts.find((f) => f.ref?.headSha === head2) ?? null;
  const laneOn = (h) => [
    ...factsOfKind(snap, 'merge.refused').filter((f) => f.ref?.pr === n && f.ref?.headSha === h).map((f) => f.at),
    ...cardsOfKind(snap, 'status').filter((c) => c.actor?.kind === 'system' && /ready to merge/i.test(c.title) && h && c.title.includes(h.slice(0, 7))).map((c) => c.at),
  ];
  const lane2 = laneOn(head2);
  const verifierWakes = wakesOf(snap, expect.verifier).filter((w) => w.reason?.kind === 'facts' && w.reason.trigger?.kind === 'pr.head_moved');
  return [
    criterion('head_moved_fact', moved.length === 1 && !!head2 && head2 !== head1, `${moved.length} pr.head_moved; ${String(head1).slice(0, 7)} → ${String(head2).slice(0, 7)}`),
    criterion('verifier_rewoken', verifierWakes.length === 1 && verifierWakes[0].state === 'done', `${verifierWakes.length} head_moved wake(s)`),
    criterion('no_lane_action_before_new_verdict', !!v2 && lane2.every((t) => t >= v2.at), lane2.length ? `lane at ${lane2.join(',')} vs verdict ${v2?.at}` : 'lane silent on the new head'),
    ...verdictCriteria(snap, expect.verifier, n, head2, '_new_head'),
    criterion('new_evidence_task', (() => {
      const recs = arr(snap.verdicts).filter((v) => v.prNumber === n);
      const t1 = recs.find((v) => v.headSha === head1)?.evidence?.taskId;
      const t2 = recs.find((v) => v.headSha === head2)?.evidence?.taskId;
      return !!t1 && !!t2 && t1 !== t2;
    })(), 'a new verify task backs the new verdict'),
    criterion('lane_acts_on_new_head', lane2.length >= 1, `${lane2.length} lane outcome(s) on the new head`),
  ];
}

/** repowatch-baseline-first-poll. */
export function repoWatchBaseline(snap, expect) {
  const facts = arr(snap.facts);
  const old = facts.filter((f) => (f.kind.startsWith('issue.') && f.ref?.issue === expect.old.issue) || (f.kind.startsWith('pr.') && f.ref?.pr === expect.old.pr) || (f.kind.startsWith('ci.') && f.ref?.pr === expect.old.pr));
  const opened = facts.filter((f) => f.kind === 'issue.opened' && f.ref?.issue === expect.new);
  const wakes = wakesOf(snap, expect.bot);
  const polls = arr(snap.gh?.calls).filter((c) => c.argv?.[1] === 'graphql' && arr(c.argv).some((a) => /open: pullRequests/.test(a)));
  const otherGraphql = arr(snap.gh?.calls).filter((c) => c.argv?.[1] === 'graphql' && !arr(c.argv).some((a) => /open: pullRequests/.test(a)));
  // Polls are 60 s apart (REPO_WATCH_LIMITS.POLL_MS): two watch reads closer
  // than half of that are one poll reading twice.
  const gaps = polls.slice(1).map((c, i) => c.at - polls[i].at);
  return [
    criterion('baseline_emits_nothing', old.length === 0, `${old.length} fact(s) about the items open before the baseline`),
    criterion('new_issue_once', opened.length === 1 && opened[0].actor?.kind === 'github', `${opened.length} issue.opened #${expect.new}`),
    criterion('triage_woken_in_issue_thread', wakes.length === 1 && wakes[0].threadId === expect.thread && wakes[0].state === 'done', wakes.map((w) => `${w.threadId}:${w.state}`).join(', ') || 'no wake'),
    criterion('one_graphql_read_per_poll', polls.length >= 2 && otherGraphql.length === 0 && gaps.every((g) => g >= 30_000),
      `${polls.length} watch read(s) ${gaps.map((g) => Math.round(g / 1000)).join('s, ')}s apart, ${otherGraphql.length} other GraphQL read(s)`),
  ];
}
