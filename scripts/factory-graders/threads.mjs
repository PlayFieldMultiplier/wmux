// Thread graders: where a bot's output lands, and that one PR or issue is
// one thread. The stub never names a thread unless the scenario says so; main
// pins it from the wake (shared/room.ts RoomPostParams).

import { arr, botCards, criterion, injected, stubEvents, wakesForFact, wakesOf } from './common.mjs';

const PARSE_RE = /^(pr|issue):((?:[A-Za-z0-9_.-]{1,100}\/){1,2}[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})$/;

/** 1. reply-in-wake-thread: the triage card lands in the issue's thread. */
export function replyInWakeThread(snap, expect) {
  const fact = injected(snap, expect.fact ?? 'issue');
  const wakes = fact ? wakesForFact(snap, fact.id) : [];
  const wake = wakes[0] ?? null;
  const cards = botCards(snap, expect.bot ?? 'triage').filter((c) => !expect.cardKind || c.kind === expect.cardKind);
  const want = expect.thread;
  return [
    criterion('wake_pinned_to_fact_thread', !!wake && wake.threadId === want, `wake ${wake?.id ?? 'none'} thread ${wake?.threadId ?? 'none'} (want ${want})`),
    criterion('card_in_wake_thread', cards.length > 0 && cards.every((c) => c.threadId === want), `${cards.length} bot card(s) in ${[...new Set(cards.map((c) => c.threadId))].join(', ') || 'none'}`),
    criterion('no_card_in_general', cards.every((c) => c.threadId !== 'general'), `${cards.filter((c) => c.threadId === 'general').length} in general`),
    criterion('one_wake', wakes.length === 1, `${wakes.length} wake(s) for the fact`),
  ];
}

/** 2. thread-id-roundtrip: two spellings of one repo give one PR thread,
 *  and a human post that names the thread with the other spelling joins it. */
export function threadIdRoundtrip(snap, expect) {
  const pr = expect.pr ?? 12;
  const prThreads = (cards) => [...new Set(cards.map((c) => c.threadId).filter((t) => typeof t === 'string' && t.startsWith('pr:') && t.endsWith(`#${pr}`)))];
  // The cards main writes from the facts (system actor), whatever their kind.
  const factThreads = prThreads(arr(snap.cards).filter((c) => c.actor?.kind === 'system'));
  const all = prThreads(arr(snap.cards));
  const human = injected(snap, expect.humanLabel);
  const humanCard = human ? arr(snap.cards).find((c) => c.id === human.id) : null;
  return [
    criterion('fact_cards_one_thread', factThreads.length === 1 && factThreads[0] === expect.thread, `fact threads for #${pr}: ${factThreads.join(', ') || 'none'} (want ${expect.thread})`),
    criterion('fact_thread_parses', factThreads.length > 0 && factThreads.every((t) => PARSE_RE.test(t)), factThreads.join(', ')),
    criterion('human_post_joins_thread', !!humanCard && humanCard.threadId === expect.thread, `human card thread ${humanCard?.threadId ?? (human ? 'card missing' : 'post refused')}`),
    criterion('one_thread_per_pr', all.length === 1, `all threads for #${pr}: ${all.join(', ') || 'none'}`),
  ];
}

/** 3. cross-thread-isolation: two PRs inside one batch window → one wake
 *  per PR thread carrying only that PR's fact, and each card in its thread. */
export function crossThreadIsolation(snap, expect) {
  const key = expect.bot ?? 'verifier';
  const factWakes = wakesOf(snap, key).filter((w) => w.reason?.kind === 'facts');
  const threads = expect.threads ?? {};
  const cards = botCards(snap, key);
  const out = [criterion('one_wake_per_thread', factWakes.length === Object.keys(threads).length
    && new Set(factWakes.map((w) => w.threadId)).size === factWakes.length,
  factWakes.map((w) => `${w.id}@${w.threadId}[${arr(w.reason.factIds).length}]`).join(', ') || 'no wakes')];
  for (const [thread, spec] of Object.entries(threads)) {
    const own = injected(snap, spec.fact);
    const wakes = factWakes.filter((w) => w.threadId === thread);
    const ids = wakes.flatMap((w) => arr(w.reason.factIds));
    out.push(criterion(`${spec.label}_wake_has_only_own_fact`, !!own && ids.length === 1 && ids[0] === own.id, `fact ids ${ids.join(', ') || 'none'}`));
    const here = cards.filter((c) => c.threadId === thread);
    out.push(criterion(`${spec.label}_card_in_own_thread`, here.length === 1, `${here.length} card(s) in ${thread}`));
    // What the turn was shown: its wake block names only its own PR.
    if (spec.title && spec.otherTitle) {
      const prompt = wakes.length === 1 ? stubEvents(snap, key, 'prompt').find((e) => String(e.text ?? '').includes(`[wake ${wakes[0].id}]`)) : null;
      const text = String(prompt?.text ?? '');
      out.push(criterion(`${spec.label}_prompt_only_own_pr`, !!prompt && text.includes(spec.title) && !text.includes(spec.otherTitle),
        prompt ? `own "${spec.title}" ${text.includes(spec.title) ? 'present' : 'missing'}, other "${spec.otherTitle}" ${text.includes(spec.otherTitle) ? 'present' : 'absent'}` : 'no prompt for the wake'));
    }
  }
  out.push(criterion('no_card_outside_pr_threads', cards.length > 0 && cards.every((c) => c.threadId in threads), cards.map((c) => c.threadId).join(', ') || 'no cards'));
  return out;
}
