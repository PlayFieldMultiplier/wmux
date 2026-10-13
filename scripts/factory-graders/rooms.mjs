// Room read graders: seq-cursor paging and per-thread read positions, from
// the reads the runner recorded as the operator.

import { arr, criterion } from './common.mjs';

function record(snap, label) {
  return arr(snap.records).find((r) => r.label === label)?.result ?? null;
}

/** 17. room-read-paging. */
export function roomReadPaging(snap, expect) {
  const pages = arr(record(snap, expect.record));
  const cards = pages.flatMap((p) => arr(p?.cards));
  const seqs = cards.map((c) => c.seq);
  const want = Math.ceil(expect.total / expect.page);
  const sorted = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const stored = arr(snap.cards).filter((c) => c.threadId === expect.thread).map((c) => c.seq);
  return [
    criterion('pages_ok', pages.length > 0 && pages.every((p) => p?.ok === true), `${pages.length} page(s)`),
    criterion('page_count', pages.length === want, `${pages.length} page(s), want ${want}`),
    criterion('page_size', pages.slice(0, -1).every((p) => arr(p.cards).length === expect.page), pages.map((p) => arr(p?.cards).length).join(',')),
    criterion('has_more_only_before_last', pages.length > 0 && pages.slice(0, -1).every((p) => p.hasMore === true) && pages[pages.length - 1].hasMore === false, pages.map((p) => p?.hasMore).join(',')),
    criterion('every_card_once_in_order', sorted && new Set(seqs).size === seqs.length && seqs.length === expect.total
      && JSON.stringify([...seqs]) === JSON.stringify(stored), `${seqs.length} read, ${new Set(seqs).size} distinct, ${stored.length} stored`),
    criterion('cursor_is_seq', pages.slice(0, -1).every((p) => p.nextSinceSeq === arr(p.cards).at(-1)?.seq), pages.map((p) => p?.nextSinceSeq).join(',')),
  ];
}

function thread(snap, label, id) {
  return arr(record(snap, label)?.threads).find((t) => t.threadId === id) ?? null;
}

/** 18. unread-independent. */
export function unreadIndependent(snap, expect) {
  const before = { a: thread(snap, 'before', expect.a), b: thread(snap, 'before', expect.b) };
  const mark = { a: thread(snap, 'afterMark', expect.a), b: thread(snap, 'afterMark', expect.b) };
  const late = { a: thread(snap, 'afterNew', expect.a), b: thread(snap, 'afterNew', expect.b) };
  return [
    criterion('threads_read', !!before.a && !!before.b && !!mark.a && !!late.a, 'three thread reads recorded'),
    criterion('unknown_is_null_not_zero', before.a?.unread === null && before.b?.unread === null, `before: ${before.a?.unread} / ${before.b?.unread}`),
    criterion('marked_thread_reads_zero', mark.a?.unread === 0, `A after mark: ${mark.a?.unread}`),
    criterion('other_thread_unchanged', mark.b?.unread === before.b?.unread && late.b?.unread === before.b?.unread, `B: ${before.b?.unread} → ${mark.b?.unread} → ${late.b?.unread}`),
    criterion('new_card_counts_one', late.a?.unread === 1, `A after a new card: ${late.a?.unread}`),
  ];
}
