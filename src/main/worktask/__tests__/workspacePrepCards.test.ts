// The "Preparing" card: a failed setup waits for the person's answer, Retry
// runs it again, Start anyway is offered only where an agent starts, Discard
// removes only what wmux made, and an unanswered card stops the wait but
// deletes nothing. The copy suggestion is made once.
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { deliberateSleep } from '../../../test-utils/waitFor';
import {
  WorkspacePrepCards,
  runWithPrepCard,
  copySuggestionFor,
  type CopySuggestionStore,
  type WorkspacePrepCard,
} from '../workspacePrepCards';
import type { WorkspacePrepResult } from '../workspacePrep';

const copy = { copied: 2, missing: 1, present: 0, refused: 0 };
const failed: WorkspacePrepResult = { status: 'failed', copy, setupRan: true, error: 'exited with code 1', outputTail: ['npm ERR! x'] };
const ready: WorkspacePrepResult = { status: 'ready', copy, setupRan: true };

function cardsWithLog() {
  const events: WorkspacePrepCard[] = [];
  const cards = new WorkspacePrepCards({ now: () => 1 });
  cards.setSink((c) => events.push(c));
  return { cards, events };
}

describe('WorkspacePrepCards', () => {
  it('shows a failure, retries on the answer, and closes once the setup succeeds', async () => {
    const { cards, events } = cardsWithLog();
    const card = cards.begin('issue-12', true);
    const run = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ready);
    const done = runWithPrepCard(card, run);
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'), { timeout: 5_000 });
    expect(cards.list()[0]).toMatchObject({ error: 'exited with code 1', outputTail: ['npm ERR! x'], copied: 2, missing: 1 });
    expect(cards.decide(card.id, 'retry')).toBe(true);
    expect(await done).toMatchObject({ next: 'start', last: { status: 'ready' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.status).toBe('closed');
    // A file that did not arrive stays on the card until it is dismissed,
    // also for a renderer that mounts later.
    expect(cards.list()).toMatchObject([{ status: 'ready', missing: 1 }]);
    expect(cards.decide(card.id, 'retry')).toBe(false);
    expect(cards.decide(card.id, 'dismiss')).toBe(true);
    expect(cards.list()).toEqual([]);
  });

  it('never auto-starts: a failure waits, and Start anyway or Dismiss is the person\'s', async () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('issue-12', true);
    const done = runWithPrepCard(card, async () => failed);
    let settled = false;
    void done.then(() => { settled = true; });
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'), { timeout: 5_000 });
    await deliberateSleep(10, 'a negative check: still nothing after the limit')
    expect(settled).toBe(false);
    expect(cards.decide(card.id, 'start')).toBe(true);
    expect((await done).next).toBe('start');

    const other = cards.begin('feat/x', false);
    const left = runWithPrepCard(other, async () => failed);
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'), { timeout: 5_000 });
    // No agent starts on the Git page: there is nothing to start anyway.
    expect(cards.decide(other.id, 'start')).toBe(false);
    expect(cards.decide(other.id, 'dismiss')).toBe(true);
    expect((await left).next).toBe('dismiss');
  });

  it('an unanswered failure stops the wait but deletes nothing, and the card still takes Discard or Keep', async () => {
    const cards = new WorkspacePrepCards({ decisionTtlMs: 5 });
    const card = cards.begin('issue-12', true, { canDiscard: true });
    const discard = vi.fn(async () => ({ removed: true as const }));
    expect((await runWithPrepCard(card, async () => failed, { discard })).next).toBe('expired');
    expect(discard).not.toHaveBeenCalled();
    expect(cards.list()[0]).toMatchObject({ status: 'failed', expired: true });
    // Nothing waits to start an agent any more.
    expect(cards.decide(card.id, 'start')).toBe(false);
    expect(cards.decide(card.id, 'retry')).toBe(false);
    await deliberateSleep(20, 'a negative check: still nothing after the limit')
    expect(cards.list()).toHaveLength(1);
    expect(cards.decide(card.id, 'discard')).toBe(true);
    await vi.waitFor(() => expect(cards.list()).toEqual([]), { timeout: 5_000 });
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('a Discard that is refused keeps the card, names the folder, and waits again', async () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('issue-12', true, { canDiscard: true });
    const discard = vi.fn(async () => ({ removed: false as const, path: '/wt/issue-12' }));
    const done = runWithPrepCard(card, async () => failed, { discard });
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'), { timeout: 5_000 });
    expect(cards.decide(card.id, 'discard')).toBe(true);
    await vi.waitFor(() => expect(cards.list()[0]?.discardRefused).toBe('/wt/issue-12'), { timeout: 5_000 });
    expect(cards.decide(card.id, 'dismiss')).toBe(true);
    expect((await done).next).toBe('dismiss');
  });

  it('Discard is refused where the card has nothing to discard', async () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('feat/x', false);
    void runWithPrepCard(card, async () => failed);
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'), { timeout: 5_000 });
    expect(cards.decide(card.id, 'discard')).toBe(false);
    cards.decide(card.id, 'dismiss');
  });

  it('a card nothing waits on (the Git page) never expires', async () => {
    const cards = new WorkspacePrepCards({ decisionTtlMs: 5 });
    const card = cards.begin('feat/x', false);
    const run = vi.fn(async () => failed);
    const done = runWithPrepCard(card, run);
    await deliberateSleep(30, 'a negative check: still nothing after the limit')
    expect(cards.list()[0]).toMatchObject({ status: 'failed' });
    expect(cards.list()[0].expired).toBeUndefined();
    expect(cards.decide(card.id, 'retry')).toBe(true);
    await vi.waitFor(() => expect(cards.decide(card.id, 'dismiss')).toBe(true), { timeout: 5_000 });
    expect((await done).next).toBe('dismiss');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses answers to a card that is not waiting', () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('issue-12', true);
    expect(cards.decide(card.id, 'retry')).toBe(false);
    expect(cards.decide('nope', 'retry')).toBe(false);
  });
});

describe('copySuggestionFor', () => {
  const memory = (): CopySuggestionStore & { roots: string[] } => {
    const roots: string[] = [];
    return { roots, has: (r) => roots.includes(r), add: (r) => { roots.push(r); } };
  };

  it('is made until a card has shown it, only when copying was never configured and a .env exists', async () => {
    const store = memory();
    const list = async () => ['.env', '.env.example', 'secret.key'];
    const suggestion = await copySuggestionFor({ found: false }, '/repo', store, list);
    expect(suggestion).toEqual({ cwd: '/repo', count: 1, root: path.resolve('/repo') });
    if (!suggestion) return;
    const cards = new WorkspacePrepCards({ suggestions: store });
    // A card whose setup failed never showed it: not used up.
    const unseen = cards.begin('a', true, { suggestCopy: suggestion });
    unseen.result(failed);
    unseen.close();
    expect(store.roots).toEqual([]);
    expect(cards.list()).toEqual([]);
    const shown = cards.begin('b', true, { suggestCopy: suggestion });
    shown.result({ ...ready, copy: { copied: 0, missing: 0, present: 0, refused: 0 } });
    shown.close();
    expect(store.roots).toEqual([path.resolve('/repo')]);
    expect(await copySuggestionFor({ found: false }, '/repo', store, list)).toBeUndefined();
    const configured = { found: true, configPath: '/other/wmux.json', config: { version: 1 as const, fanout: { copy: [] as string[] } } };
    expect(await copySuggestionFor({ ...configured, config: { version: 1, fanout: { copy: ['.env'] } } }, '/other', store, list)).toBeUndefined();
    expect(await copySuggestionFor({ found: false }, '/none', store, async () => ['secret.key'])).toBeUndefined();
  });

  it('a kept card dismissed in one window is dropped in every window', () => {
    const { cards, events } = cardsWithLog();
    const card = cards.begin('a', true);
    card.result({ ...ready });
    card.close();
    expect(events.at(-1)).toMatchObject({ status: 'closed' });
    expect(events.at(-1)?.gone).toBeUndefined();
    expect(cards.decide(card.id, 'dismiss')).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'closed', gone: true });
  });

  it('is not made for a project whose wmux.json waits for review, and stays unmade', async () => {
    const store = memory();
    const list = async () => ['.env'];
    const denied = { found: true, configPath: '/r/wmux.json', trust: 'denied' as const, config: { version: 1 as const } };
    expect(await copySuggestionFor(denied, '/r', store, list)).toBeUndefined();
    expect(store.roots).toEqual([]);
  });
});
