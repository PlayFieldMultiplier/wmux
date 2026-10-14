// Owner-approval graders: a bot's merge request is approved only by the
// owner's own words after its card, a card answer or a remembered rule; an
// approved merge waits out the Undo window and goes out at the head the
// request recorded; a moved head is refused; a worker started from outside
// text never reaches the lane.

import { arr, botId, cardsOfKind, criterion, factsOfKind, injected } from './common.mjs';

const UNDO_MS = 10_000;
const REPO = 'github.com/acme/app';

function pr(snap, n) {
  return arr(snap.gh?.state?.repos?.[REPO]?.prs).find((p) => p.number === n) ?? null;
}

function mergeCalls(snap, n) {
  return arr(snap.gh?.calls).filter((c) => c.argv?.[0] === 'pr' && c.argv?.[1] === 'merge' && (n === undefined || String(c.argv?.[2]) === String(n)));
}

function flagValue(argv, flag) {
  const a = arr(argv);
  const i = a.indexOf(flag);
  if (i >= 0) return a[i + 1] ?? null;
  const eq = a.find((x) => String(x).startsWith(`${flag}=`));
  return eq ? String(eq).slice(flag.length + 1) : null;
}

function requestsFor(snap, n) {
  return arr(snap.approvals).filter((r) => r.action === 'merge' && r.prNumber === n);
}

/** approval-typed-merge. */
export function approvalTypedMerge(snap, expect) {
  const id = botId(snap, expect.bot);
  const go = injected(snap, expect.go);
  const goCard = go ? arr(snap.cards).find((c) => c.id === go.id) : null;
  const out = [];
  for (const n of expect.prs ?? [1, 2]) {
    const reqs = requestsFor(snap, n);
    const r = reqs[0];
    const card = r?.cardId ? arr(snap.cards).find((c) => c.id === r.cardId) : null;
    const calls = mergeCalls(snap, n);
    out.push(
      criterion(`request_${n}_by_main`, reqs.length === 1 && r.botId === id && r.headSha === pr(snap, n)?.headSha && typeof r.ghLogin === 'string',
        r ? `${reqs.length} request(s), head ${String(r.headSha).slice(0, 7)} login ${r.ghLogin}` : 'no request'),
      criterion(`card_${n}_before_words`, !!card && !!goCard && card.kind === 'approval' && card.threadId === goCard.threadId && card.seq < goCard.seq,
        card ? `card seq ${card.seq} ${card.threadId}; words seq ${goCard?.seq} ${goCard?.threadId}` : 'no card'),
      criterion(`approved_by_owner_words_${n}`, r?.decidedBy === 'owner' && r?.state === 'executed' && typeof r.decidedAt === 'number' && !!goCard && r.decidedAt >= goCard.at,
        r ? `${r.state} by ${r.decidedBy} at ${r.decidedAt}` : 'no request'),
      criterion(`merged_after_undo_${n}`, calls.length === 1 && typeof r?.decidedAt === 'number' && calls[0].at >= r.decidedAt + UNDO_MS,
        calls.length ? `merge ${calls[0].at - (r?.decidedAt ?? 0)} ms after approval` : 'no merge call'),
      // The merge call's own exit, not the scripted GitHub's state file: two
      // concurrent fake-gh merges can overwrite each other's write.
      criterion(`merged_at_requested_head_${n}`, calls.length === 1 && calls[0].exit === 0 && flagValue(calls[0].argv, '--match-head-commit') === r?.headSha,
        calls.length ? `--match-head-commit ${String(flagValue(calls[0].argv, '--match-head-commit')).slice(0, 7)}; exit ${calls[0].exit}` : 'no merge call'),
    );
  }
  out.push(criterion('merge_facts', factsOfKind(snap, 'merge.done').filter((f) => f.payload?.approvedBy === 'owner').length === (expect.prs ?? [1, 2]).length,
    `${factsOfKind(snap, 'merge.done').length} merge.done fact(s)`));
  return out;
}

/** approval-needs-owner-words. */
export function approvalNeedsOwnerWords(snap, expect) {
  const n = expect.pr ?? 1;
  const reqs = requestsFor(snap, n);
  const r = reqs[0];
  const botWords = cardsOfKind(snap, 'status').filter((c) => c.actor?.kind === 'bot' && c.title === '머지해');
  return [
    criterion('request_made', reqs.length === 1, `${reqs.length} request(s)`),
    criterion('still_waits_for_owner', r?.state === 'pending' && r?.decidedBy === undefined, r ? `${r.state} ${r.decidedBy ?? ''}` : 'no request'),
    criterion('bot_words_posted', botWords.length === 1, `${botWords.length} bot card(s) saying 머지해`),
    criterion('nothing_merged', mergeCalls(snap).length === 0 && pr(snap, n)?.state === 'OPEN' && arr(snap.effects).length === 0,
      `${mergeCalls(snap).length} merge call(s); PR ${pr(snap, n)?.state}; ${arr(snap.effects).length} effect(s)`),
  ];
}

/** approval-head-moved. */
export function approvalHeadMoved(snap, expect) {
  const n = expect.pr ?? 1;
  const r = requestsFor(snap, n)[0];
  const approve = arr(snap.records).find((x) => x.label === 'approve')?.result;
  const outcome = arr(snap.cards).find((c) => c.kind === 'refusal' && c.refs?.approvalId === r?.requestId);
  return [
    criterion('owner_approved_on_card', approve?.ok === true && r?.decidedBy === 'owner', JSON.stringify(approve ?? null).slice(0, 160)),
    criterion('refused_head_moved', r?.state === 'refused' && r?.refusal === 'head-moved', r ? `${r.state} ${r.refusal ?? ''}` : 'no request'),
    criterion('nothing_merged', mergeCalls(snap).length === 0 && pr(snap, n)?.state === 'OPEN', `${mergeCalls(snap).length} merge call(s); PR ${pr(snap, n)?.state}`),
    criterion('new_request_needed_card', !!outcome && /new approval/i.test(outcome.title), outcome?.title ?? 'no outcome card'),
  ];
}

/** taint-lane-refused. */
export function taintLaneRefused(snap, expect) {
  const n = expect.pr ?? 1;
  const head = snap.saved?.[`pr${n}Head`];
  const lid = botId(snap, expect.lead);
  const leadRows = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === lid);
  const refused = factsOfKind(snap, 'merge.refused').filter((f) => f.ref?.pr === n && f.ref?.headSha === head);
  return [
    criterion('lead_task_tainted', leadRows.length >= 1 && leadRows.every((e) => e.dispatch?.origin?.tainted === true),
      leadRows.map((e) => `${e.id}:${e.dispatch?.origin?.tainted === true}`).join(', ') || 'no lead task'),
    criterion('verifier_passed', arr(snap.verdicts).some((v) => v.prNumber === n && v.headSha === head && v.verdict === 'pass'), 'a PASS at the head'),
    criterion('lane_refused_tainted', refused.length === 1 && String(refused[0].payload?.reason ?? '').includes('tainted-origin'),
      refused.map((f) => f.payload?.reason).join(' | ') || 'no merge.refused'),
    criterion('nothing_merged', mergeCalls(snap).length === 0 && pr(snap, n)?.state === 'OPEN', `${mergeCalls(snap).length} merge call(s); PR ${pr(snap, n)?.state}`),
  ];
}

/** approval-rule-next-time. */
export function approvalRuleNextTime(snap, expect) {
  const first = requestsFor(snap, expect.outsidePr ?? 2)[0];
  const next = requestsFor(snap, expect.pr ?? 1)[0];
  const rules = arr(snap.approvalRules);
  const lid = botId(snap, expect.lead);
  const always = arr(snap.records).find((x) => x.label === 'always')?.result;
  return [
    criterion('rule_remembered', always?.ok === true && rules.length === 1 && rules[0].action === 'merge' && rules[0].scope?.botId === lid && rules[0].repoKey === REPO,
      JSON.stringify(rules).slice(0, 200)),
    criterion('first_by_owner', first?.decidedBy === 'owner' && first?.state === 'executed' && pr(snap, expect.outsidePr ?? 2)?.state === 'MERGED',
      first ? `${first.state} by ${first.decidedBy}` : 'no first request'),
    criterion('next_by_rule', next?.decidedBy === 'rule' && next?.ruleId === rules[0]?.ruleId && next?.tainted === false,
      next ? `${next.state} by ${next.decidedBy} rule ${next.ruleId}` : 'no next request'),
    criterion('next_merged', next?.state === 'executed' && pr(snap, expect.pr ?? 1)?.state === 'MERGED',
      next ? `${next.state} ${next.refusal ?? ''}; PR ${pr(snap, expect.pr ?? 1)?.state}` : 'no next request'),
  ];
}
