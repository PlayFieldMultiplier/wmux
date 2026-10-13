// Handoff graders: dispatch / result callbacks, chain limits, questions to
// the owner, the owner's corrections, and the HQ bot's morning output.

import { arr, botCards, botId, cardsOfKind, criterion, factsOfKind, handoffsOfKind, stubTools, parseToolText, wakesOf } from './common.mjs';

/** 8. callback-exactly-once. */
export function callbackExactlyOnce(snap, expect) {
  const sender = botId(snap, expect.sender);
  const receiver = botId(snap, expect.receiver);
  const results = handoffsOfKind(snap, 'result').filter((h) => h.from?.botId === sender);
  const delivered = results.filter((h) => h.status === 'delivered' || h.status === 'answered');
  const refused = results.filter((h) => h.status === 'refused' && h.refusal?.code === 'duplicate_result');
  const handoffWakes = wakesOf(snap, expect.receiver).filter((w) => w.reason?.kind === 'handoff' && w.state === 'done');
  const refusalCards = cardsOfKind(snap, 'refusal');
  return [
    criterion('two_results_sent', results.length === 2, `${results.length} result handoff(s)`),
    criterion('one_result_delivered', delivered.length === 1 && delivered[0].to?.botId === receiver, delivered.map((h) => `${h.id}:${h.status}`).join(', ') || 'none'),
    criterion('second_refused_duplicate', refused.length === 1, results.map((h) => `${h.status}/${h.refusal?.code ?? '-'}`).join(', ')),
    criterion('receiver_woken_once', handoffWakes.length === 1 && handoffWakes[0].reason.handoffId === delivered[0]?.id, `${handoffWakes.length} handoff wake(s)`),
    criterion('refusal_card', refusalCards.length >= 1, `${refusalCards.length} refusal card(s)`),
  ];
}

/** 11. hop-limit-refusal: depth climbs 1..maxDepth, the next hop is
 *  refused, nothing past it. */
export function hopLimitRefusal(snap, expect) {
  const max = expect.maxDepth ?? 6;
  const hs = arr(snap.handoffs);
  const refused = hs.filter((h) => h.status === 'refused' && h.refusal?.code === expect.code);
  const deliveredDepths = hs.filter((h) => h.status !== 'refused').map((h) => h.depth).sort((a, b) => a - b);
  const facts = factsOfKind(snap, 'handoff.refused');
  const runIds = new Set(hs.map((h) => h.runId));
  // A Coordinator's chain starts at depth 0, any other bot's at 1.
  const start = expect.startDepth ?? 0;
  const want = Array.from({ length: max - start + 1 }, (_, i) => i + start);
  return [
    criterion('chain_climbs_to_limit', JSON.stringify(deliveredDepths) === JSON.stringify(want), `delivered depths ${deliveredDepths.join(',')}`),
    criterion(`refused_${expect.code}`, refused.length === 1 && refused[0].depth === max + 1, refused.map((h) => `depth ${h.depth}`).join(', ') || 'none'),
    criterion('one_run', runIds.size === 1, `${runIds.size} run id(s)`),
    criterion('refused_fact', facts.length === 1 && facts[0].ref?.handoffId === refused[0]?.id, `${facts.length} handoff.refused fact(s)`),
    criterion('refusal_card', cardsOfKind(snap, 'refusal').length >= 1, `${cardsOfKind(snap, 'refusal').length} refusal card(s)`),
    criterion('nothing_past_limit', hs.every((h) => h.depth <= max + 1) && hs.length === want.length + 1, `${hs.length} handoff(s)`),
  ];
}

/** 4. interleaved-worker-reports. */
export function interleavedWorkerReports(snap, expect) {
  const leadId = botId(snap, expect.lead);
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === leadId);
  // A report reaches the lead after main's gate on it (task.gated:…); a
  // snapshot from before that gate existed carries task.review_requested:….
  const reportWakes = wakesOf(snap, expect.lead).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((id) => /^task\.(review_requested|gated):/.test(id)));
  const reported = new Set(reportWakes.flatMap((w) => arr(w.reason.factIds)).map((id) => (/^task\.[a-z_]+:(.+)@\d+$/.exec(id) ?? [])[1]).filter(Boolean));
  const results = handoffsOfKind(snap, 'result').filter((h) => h.from?.botId === leadId);
  const delivered = results.filter((h) => h.status === 'delivered' || h.status === 'answered');
  const moaHandoffWakes = wakesOf(snap, expect.moa).filter((w) => w.reason?.kind === 'handoff' && w.state === 'done');
  const others = arr(snap.wakes).filter((w) => w.botId !== leadId && w.botId !== botId(snap, expect.moa));
  return [
    // Reported, and completed when main's gate on the report passed.
    criterion('tasks_reported', tasks.length === expect.tasks && tasks.every((e) => e.status === 'review_requested' || e.status === 'completed'), tasks.map((e) => e.status).join(', ') || 'no tasks'),
    // Task wakes are pinned to each task's thread and merge only within one
    // thread (fanoutCallerNotify installBotFanoutWake), so N reports are N
    // lead turns by design; the count is reported, not graded.
    criterion('every_report_reached_lead', tasks.length === expect.tasks && tasks.every((e) => reported.has(e.id)),
      `${reported.size}/${tasks.length} task(s) in ${reportWakes.length} lead wake(s)`),
    criterion('one_result_to_moa', delivered.length === 1 && moaHandoffWakes.filter((w) => w.reason.handoffId === delivered[0].id).length === 1, `${delivered.length} delivered of ${results.length} result(s)`),
    criterion('extra_results_refused', results.length - delivered.length === results.filter((h) => h.refusal?.code === 'duplicate_result').length, results.map((h) => h.refusal?.code ?? h.status).join(', ')),
    criterion('no_other_bot_woken', others.length === 0, `${others.length} other wake(s)`),
  ];
}

/** 9. ask-person-question-card. */
export function askPersonQuestionCard(snap, expect) {
  const id = botId(snap, expect.bot);
  const question = cardsOfKind(snap, 'question')[0] ?? null;
  const ask = handoffsOfKind(snap, 'ask_person').find((h) => h.from?.botId === id) ?? null;
  const answer = handoffsOfKind(snap, 'answer').find((h) => h.to?.botId === id) ?? null;
  const answerWake = wakesOf(snap, expect.bot).find((w) => w.reason?.kind === 'handoff' && w.reason.handoffId === answer?.id) ?? null;
  const after = botCards(snap, expect.bot).filter((c) => c.title === 'Answer received');
  return [
    criterion('question_in_wake_thread', !!question && question.threadId === expect.thread, question?.threadId ?? 'no question card'),
    criterion('question_resolved', question?.state === 'resolved', question?.state ?? 'none'),
    criterion('ask_recorded', !!ask && ask.threadId === expect.thread, ask ? `${ask.status} in ${ask.threadId}` : 'no ask_person handoff'),
    criterion('answer_handoff_carries_choice', !!answer && JSON.stringify(answer.payload ?? {}).includes(expect.answer), answer ? answer.payload?.body?.slice(0, 120) ?? '' : 'no answer handoff'),
    criterion('asker_woken_with_answer', !!answerWake && answerWake.state === 'done' && answerWake.threadId === expect.thread, answerWake ? `${answerWake.state} ${answerWake.threadId}` : 'no answer wake'),
    criterion('followup_card_in_thread', after.length === 1 && after[0].threadId === expect.thread, after.map((c) => c.threadId).join(', ') || 'none'),
  ];
}

/** human.correction on plan decline. */
export function humanCorrectionPlanDecline(snap, expect) {
  const moa = botId(snap, expect.moa);
  const plan = cardsOfKind(snap, 'plan')[0] ?? null;
  const corrections = factsOfKind(snap, 'human.correction').filter((f) => f.ref?.botId === moa);
  // handoffs.jsonl exists only once a handoff was ever sent: also read the
  // facts a delivery writes, so a missing file cannot hide a dispatch.
  const dispatches = [...handoffsOfKind(snap, 'dispatch'), ...factsOfKind(snap, 'handoff.received')];
  const leadWakes = wakesOf(snap, expect.lead);
  const moaWakes = wakesOf(snap, expect.moa);
  return [
    criterion('plan_card_resolved', plan?.state === 'resolved', plan?.state ?? 'no plan card'),
    criterion('correction_recorded', corrections.length === 1 && corrections[0].payload?.category === expect.category, corrections.map((f) => f.payload?.category).join(', ') || 'none'),
    criterion('nothing_dispatched', dispatches.length === 0 && leadWakes.length === 0, `${dispatches.length} dispatch(es), ${leadWakes.length} lead wake(s)`),
    // A decline is recorded, not delivered: it costs Moa no turn (morningReport.ts routePlanAnswer).
    criterion('decline_costs_no_turn', moaWakes.length === 1, moaWakes.map((w) => `${w.reason?.kind}@${w.threadId ?? '-'}`).join(', ')),
  ];
}

/** 22. moa-morning-report (shape). */
export function moaMorningReport(snap, expect) {
  const moa = botId(snap, expect.moa);
  const wakes = wakesOf(snap, expect.moa);
  const reports = botCards(snap, expect.moa).filter((c) => c.kind === 'report');
  const plans = cardsOfKind(snap, 'plan');
  const propose = stubTools(snap, expect.moa, 'plan_propose').map((e) => parseToolText(e.text));
  const plan = plans[0] ?? null;
  return [
    criterion('woken_once_by_schedule', wakes.length === 1 && wakes[0].reason?.kind === 'facts' && wakes[0].reason.trigger?.kind === 'schedule.fired', wakes.map((w) => w.reason?.trigger?.kind ?? w.reason?.kind).join(', ')),
    criterion('one_report_card', reports.length === 1 && reports[0].workspaceId === snap.workspaceId, `${reports.length} report card(s)`),
    criterion('one_open_plan_card', plans.length === 1 && plan.state === 'open' && plan.actor?.botId === moa, `${plans.length} plan card(s), state ${plan?.state ?? '-'}`),
    criterion('plan_names_target_workspace', !!plan && !!snap.workspaceId
      && (`${plan.body ?? ''}`.includes(snap.workspaceId) || propose.some((p) => JSON.stringify(p ?? {}).includes(snap.workspaceId))), plan?.body?.slice(0, 160) ?? 'none'),
    criterion('no_lead_woken', arr(snap.wakes).every((w) => w.botId === moa), `${arr(snap.wakes).length} wake(s) total`),
  ];
}


/** lead-task-system-gate: a lead task's report is gated and completed by
 *  main, and the lead takes one turn after it without settling the task. */
export function leadTaskSystemGate(snap, expect) {
  const leadId = botId(snap, expect.lead);
  const lead = arr(snap.bots).find((b) => b.id === leadId) ?? null;
  const tasks = arr(snap.ledger).filter((e) => e.dispatch?.origin?.botId === leadId);
  const task = tasks.length === 1 ? tasks[0] : null;
  const gate = task?.gate ?? null;
  const reports = arr(snap.workers).filter((e) => e.event === 'ledger_update');
  const taskWakes = wakesOf(snap, expect.lead).filter((w) => w.reason?.kind === 'facts' && arr(w.reason.factIds).some((id) => /^task\./.test(id)));
  const gatedWakes = taskWakes.filter((w) => arr(w.reason.factIds).some((id) => id.startsWith(`task.gated:${task?.id}@`)));
  const settles = stubTools(snap, expect.lead, 'ledger_update');
  const checked = arr(snap.cards).filter((c) => c.actor?.kind === 'system' && c.title === 'Task checked: gate passed, task completed');
  return [
    criterion('one_task', !!task, `${tasks.length} lead task(s)`),
    criterion('worker_reported', reports.length >= 1, `${reports.length} worker report(s)`),
    criterion('system_gate_passed', !!gate && gate.recordedBy === 'system' && gate.exitCode === 0 && !gate.skipped, gate ? `exit ${gate.exitCode} by ${gate.recordedBy}${gate.skipped ? ` (${gate.skipped})` : ''}` : 'no gate'),
    criterion('completed_unforced_as_owner', task?.status === 'completed' && task.updatedBy?.kind === 'brain' && task.updatedBy.workspaceId === lead?.workspaceId && !String(task.summary ?? '').includes('[forced:'),
      task ? `${task.status} by ${task.updatedBy?.kind}` : 'no task'),
    criterion('lead_woken_once_after_gate', taskWakes.length === 1 && gatedWakes.length === 1 && gatedWakes[0].state === 'done',
      taskWakes.map((w) => `${arr(w.reason.factIds).join('+')}:${w.state}`).join(', ') || 'no task wake'),
    criterion('lead_did_not_settle', settles.length === 0, `${settles.length} ledger_update call(s) by the lead`),
    criterion('checked_card', checked.length === 1, `${checked.length} checked card(s)`),
  ];
}
