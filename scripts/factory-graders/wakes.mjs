// Wake graders: who wakes on what, and what the queue does with a wake that
// arrives while a bot is busy, over budget, retried or cut by a restart.

import { arr, botCards, botId, cardsOfKind, criterion, factsOfKind, injected, stubEvents, stubTools, wakesForFact, wakesOf, parseToolText } from './common.mjs';

/** 5. no-self-wake: the fact a bot is the actor of wakes the HQ bot, never
 *  the bot itself (even with a trigger on that kind). */
export function noSelfWake(snap, expect) {
  const actorId = botId(snap, expect.actor);
  const facts = factsOfKind(snap, expect.kind).filter((f) => f.actor?.kind === 'bot' && f.actor.id === actorId);
  const wakes = facts.flatMap((f) => wakesForFact(snap, f.id));
  const self = wakes.filter((w) => w.botId === actorId);
  const observer = wakes.filter((w) => w.botId === botId(snap, expect.observer));
  return [
    criterion('own_fact_recorded', facts.length >= 1, `${facts.length} ${expect.kind} fact(s) with ${expect.actor} as actor`),
    criterion('actor_not_woken', facts.length >= 1 && self.length === 0, `${self.length} wake(s) of ${expect.actor} on its own fact`),
    criterion('observer_woken_once', observer.length === 1, `${observer.length} wake(s) of ${expect.observer}`),
  ];
}

/** 6. directed-fact-only-addressee: a message naming one bot is one
 *  directed fact for it, one wake of it, and nobody else's. */
export function directedFactOnlyAddressee(snap, expect) {
  const msg = injected(snap, expect.message);
  const addresseeId = botId(snap, expect.addressee);
  const facts = arr(snap.facts).filter((f) => f.kind === 'human.message' && f.payload?.cardId === msg?.id);
  const card = arr(snap.cards).find((c) => c.id === msg?.id) ?? null;
  const addressee = wakesOf(snap, expect.addressee);
  const out = [
    criterion('fact_directed_to_addressee', facts.length === 1 && facts[0].ref?.botId === addresseeId, `${facts.length} human.message fact(s), ref.botId ${facts[0]?.ref?.botId ?? 'none'}`),
    criterion('card_names_its_addressee', JSON.stringify(card?.refs?.botIds ?? null) === JSON.stringify([addresseeId]) && card?.refs?.botId === addresseeId, JSON.stringify(card?.refs ?? null)),
    criterion('addressee_woken_once', addressee.length === 1 && addressee[0].reason?.kind === 'human', addressee.map((w) => w.reason?.kind).join(', ') || 'no wake'),
  ];
  for (const key of expect.bystanders ?? [expect.bystander]) {
    out.push(criterion(`${key}_not_woken`, wakesOf(snap, key).length === 0, `${wakesOf(snap, key).length} wake(s) of ${key}`));
  }
  return out;
}

/** 7. narrative-name-no-wake. */
export function narrativeNameNoWake(snap, expect) {
  const speakerCards = botCards(snap, expect.speaker);
  const out = [
    criterion('speaker_card_names_bots', speakerCards.some((c) => /@triage/i.test(c.body ?? '') && /verifier/i.test(c.body ?? '')), `${speakerCards.length} card(s) by ${expect.speaker}`),
    criterion('speaker_woken_once', wakesOf(snap, expect.speaker).length === 1, `${wakesOf(snap, expect.speaker).length} wake(s)`),
  ];
  for (const key of expect.named ?? []) {
    out.push(criterion(`${key}_not_woken`, wakesOf(snap, key).length === 0, `${wakesOf(snap, key).length} wake(s)`));
  }
  return out;
}

/** 14. budget-stop: out of turns, the owner's own message still runs;
 *  the owner's answer to the bot's question is held (queued, on disk across
 *  a restart, one status card in its thread), never dropped; the owner's
 *  resume runs it once. */
export function budgetStop(snap, expect) {
  const id = botId(snap, expect.bot);
  const wakes = wakesOf(snap, expect.bot);
  const human = wakes.filter((w) => w.reason?.kind === 'human');
  const held = wakes.find((w) => w.reason?.kind === 'handoff' && w.threadId === expect.thread) ?? null;
  const answer = arr(snap.handoffs).find((h) => h.kind === 'answer' && h.id === held?.reason?.handoffId) ?? null;
  const facts = factsOfKind(snap, 'bot.budget_exhausted').filter((f) => f.ref?.botId === id);
  const heldCards = cardsOfKind(snap, 'budget').filter((c) => c.threadId === expect.thread && /^Queued: /.test(c.title ?? ''));
  const prompts = stubEvents(snap, expect.bot, 'prompt');
  const action = (label) => arr(snap.actions).find((a) => a.label === label) ?? null;
  const resume = action('resume');
  return [
    criterion('first_turn_ran', human.some((w) => w.state === 'done' && w.threadId === expect.thread), human.map((w) => `${w.threadId ?? 'general'}:${w.state}`).join(', ')),
    criterion('owner_message_ran_over_cap', human.length === 2 && human.every((w) => w.state === 'done'), human.map((w) => `${w.state}${w.dropped ? `/${w.dropped.code}` : ''}`).join(', ')),
    criterion('held_answer_not_dropped', !!held && !!answer && held.state !== 'dropped', held ? `${held.state} (${answer?.kind ?? 'no answer handoff'})` : 'no answer wake'),
    criterion('parked_on_budget', snap.saved?.presence === 'parked', `presence ${snap.saved?.presence ?? 'unknown'}`),
    criterion('budget_fact', facts.length === 1, `${facts.length} bot.budget_exhausted fact(s)`),
    criterion('held_card_once', heldCards.length === 1, `${heldCards.length} held card(s) in ${expect.thread}`),
    criterion('held_across_restart', action('still held after restart')?.ok === true, JSON.stringify(action('still held after restart')?.ok ?? null)),
    criterion('held_ran_after_resume', held?.state === 'done' && prompts.length === 3 && !!resume && prompts[2].at >= resume.at, `${held?.state ?? 'none'}; ${prompts.length} prompt(s)`),
    criterion('no_retry_loop', prompts.length <= 3, `${prompts.length} prompt(s) reached the engine`),
  ];
}

/** 12 / 13. human-queued-not-refused, steer-only-same-thread: messages
 *  posted during a running turn are accepted, queued, never folded into the
 *  running turn, and each runs later pinned to its own thread. */
export function humanQueued(snap, expect) {
  const first = injected(snap, expect.first);
  const prompts = stubEvents(snap, expect.bot, 'prompt');
  const wakes = wakesOf(snap, expect.bot).filter((w) => w.reason?.kind === 'human');
  const firstWake = wakes.find((w) => w.threadId === expect.threads[expect.first]) ?? null;
  // The first turn runs from the moment the runner saw its wake running
  // (the session spawn comes before the first prompt) to the next prompt.
  const running = arr(snap.actions).find((a) => a.label === 'first running' && a.ok === true);
  const firstStart = running?.doneAt ?? Infinity;
  const firstEnd = prompts.length >= 2 ? prompts[1].at : Infinity;
  const out = [criterion('first_turn_ran', !!first && !!firstWake && firstWake.state === 'done', firstWake?.state ?? 'no wake')];
  const claimed = new Set(firstWake ? [firstWake.id] : []);
  for (const label of expect.queued) {
    const inj = injected(snap, label);
    const want = expect.threads[label];
    // The wake that message queued: same thread, enqueued at the post, not the first one.
    const w = wakes.find((x) => !claimed.has(x.id) && x.threadId === want && inj && x.enqueuedAt >= inj.at - 50) ?? null;
    if (w) claimed.add(w.id);
    out.push(criterion(`${label}_post_accepted`, !!inj, inj ? `card ${inj.id}` : 'post refused'));
    out.push(criterion(`${label}_queued_during_turn`, !!w && w.enqueuedAt > firstStart && w.enqueuedAt < firstEnd, w ? `enqueued ${w.enqueuedAt}, turn ${firstStart}..${firstEnd}` : 'no wake'));
    out.push(criterion(`${label}_own_wake_in_its_thread`, !!w && w.state === 'done' && w.priority === 0, w ? `${w.id} ${w.threadId} ${w.state}` : 'no wake'));
  }
  out.push(criterion('one_turn_per_message', prompts.length === 1 + expect.queued.length && wakes.length === 1 + expect.queued.length,
    `${prompts.length} prompt(s), ${wakes.length} human wake(s) for ${1 + expect.queued.length} message(s)`));
  // Execution order = the order the engine was shown each wake (the prompt
  // names its wake id); arrival order = when each wake was enqueued.
  const ran = prompts.map((p) => (/\[wake (w-[^\]\s]+)\]/.exec(String(p.text ?? '')) ?? [])[1]).filter(Boolean);
  const arrived = [...wakes].sort((a, b) => a.enqueuedAt - b.enqueuedAt).map((w) => w.id);
  out.push(criterion('runs_in_arrival_order', ran.length === arrived.length && ran.every((id, i) => id === arrived[i]), `ran ${ran.join(', ')}; arrived ${arrived.join(', ')}`));
  return out;
}

/** 10. idempotent-post-retry. */
export function idempotentPostRetry(snap, expect) {
  const msg = injected(snap, expect.message);
  const wake = wakesOf(snap, expect.bot).find((w) => w.reason?.kind === 'human') ?? null;
  const cards = botCards(snap, expect.bot).filter((c) => c.title === expect.title);
  const posts = stubTools(snap, expect.bot, 'room_post');
  const second = posts[1] ? parseToolText(posts[1].text) : null;
  return [
    criterion('turn_was_retried', !!wake && wake.attempts === 2, `attempts ${wake?.attempts ?? 'none'}`),
    criterion('retry_finished', !!wake && wake.state === 'done', wake?.state ?? 'no wake'),
    criterion('posted_twice', posts.length === 2, `${posts.length} room_post call(s)`),
    criterion('exactly_one_card', cards.length === 1, `${cards.length} card(s) titled "${expect.title}"`),
    criterion('second_post_is_duplicate', second?.ok === true && second?.duplicate === true && second?.card?.id === cards[0]?.id, `second answer: ${posts[1]?.text?.slice(0, 120) ?? 'none'}`),
    criterion('card_in_message_thread', cards.length === 1 && !!msg && cards[0].threadId === msg.threadId, cards[0]?.threadId ?? 'none'),
  ];
}

/** 19. presence-unknown (bot.list as the runtime reports it). */
export function presenceUnknown(snap, expect) {
  const rec = arr(snap.records).find((r) => r.label === expect.record);
  const rows = arr(rec?.result?.result?.bots ?? rec?.result?.bots);
  const out = [criterion('bot_list_read', rows.length > 0, `${rows.length} row(s)`)];
  for (const [key, want] of Object.entries(expect.presence ?? {})) {
    const row = rows.find((r) => r.bot?.id === botId(snap, key));
    out.push(criterion(`${key}_${want}`, row?.status?.presence === want, `presence ${row?.status?.presence ?? 'missing'}`));
  }
  return out;
}

/** R8. interrupted-wake-after-restart. */
export function interruptedAfterRestart(snap, expect) {
  const msg = injected(snap, expect.message);
  const wakes = wakesOf(snap, expect.bot);
  const wake = wakes.find((w) => w.reason?.kind === 'human') ?? null;
  const prompts = stubEvents(snap, expect.bot, 'prompt');
  const all = arr(snap.cards).filter((c) => c.actor?.kind === 'system' && /interrupt/i.test(`${c.title} ${c.body ?? ''}`));
  const cards = all.filter((c) => c.threadId === expect.thread);
  return [
    criterion('restarted', arr(snap.launches).filter((l) => l.ok).length === 2, `${arr(snap.launches).length} launch(es)`),
    criterion('wake_interrupted', !!msg && wake?.state === 'interrupted', wake?.state ?? 'no wake'),
    criterion('interrupted_card', all.length === 1, `${all.length} interrupted card(s): ${all.map((c) => c.threadId).join(', ')}`),
    criterion('interrupted_card_in_thread', cards.length === 1, `${cards.length} in ${expect.thread}`),
    criterion('not_replayed', prompts.length === 1 && wakes.every((w) => w.state !== 'done' && w.state !== 'running'), `${prompts.length} prompt(s); states ${wakes.map((w) => w.state).join(', ')}`),
  ];
}
