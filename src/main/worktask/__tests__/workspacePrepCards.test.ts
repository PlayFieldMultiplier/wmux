// The "Preparing" card: a failed setup waits for the person's answer, Retry
// runs it again, Start anyway is offered only where an agent starts, and an
// unanswered card counts as dismissed. The copy suggestion is made once.
import { describe, it, expect, vi } from 'vitest';
import {
  WorkspacePrepCards,
  runWithPrepCard,
  takeCopySuggestion,
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
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'));
    expect(cards.list()[0]).toMatchObject({ error: 'exited with code 1', outputTail: ['npm ERR! x'], copied: 2, missing: 1 });
    expect(cards.decide(card.id, 'retry')).toBe(true);
    expect(await done).toMatchObject({ next: 'start', last: { status: 'ready' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.status).toBe('closed');
    expect(cards.list()).toEqual([]);
  });

  it('never auto-starts: a failure waits, and Start anyway or Dismiss is the person\'s', async () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('issue-12', true);
    const done = runWithPrepCard(card, async () => failed);
    let settled = false;
    void done.then(() => { settled = true; });
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(cards.decide(card.id, 'start')).toBe(true);
    expect((await done).next).toBe('start');

    const other = cards.begin('feat/x', false);
    const left = runWithPrepCard(other, async () => failed);
    await vi.waitFor(() => expect(cards.list()[0]?.status).toBe('failed'));
    // No agent starts on the Git page: there is nothing to start anyway.
    expect(cards.decide(other.id, 'start')).toBe(false);
    expect(cards.decide(other.id, 'dismiss')).toBe(true);
    expect((await left).next).toBe('dismiss');
  });

  it('an unanswered failure counts as dismissed', async () => {
    const cards = new WorkspacePrepCards({ decisionTtlMs: 5 });
    const card = cards.begin('issue-12', true);
    expect((await runWithPrepCard(card, async () => failed)).next).toBe('dismiss');
  });

  it('refuses answers to a card that is not waiting', () => {
    const { cards } = cardsWithLog();
    const card = cards.begin('issue-12', true);
    expect(cards.decide(card.id, 'retry')).toBe(false);
    expect(cards.decide('nope', 'retry')).toBe(false);
  });
});

describe('takeCopySuggestion', () => {
  const memory = (): CopySuggestionStore & { roots: string[] } => {
    const roots: string[] = [];
    return { roots, has: (r) => roots.includes(r), add: (r) => { roots.push(r); } };
  };

  it('is made once per project, only when copying was never configured and a .env exists', async () => {
    const store = memory();
    const list = async () => ['.env', '.env.example', 'secret.key'];
    expect(await takeCopySuggestion({ found: false }, '/repo', store, list)).toEqual({ cwd: '/repo', count: 1 });
    expect(await takeCopySuggestion({ found: false }, '/repo', store, list)).toBeUndefined();
    const configured = { found: true, configPath: '/other/wmux.json', config: { version: 1 as const, fanout: { copy: [] as string[] } } };
    expect(await takeCopySuggestion({ ...configured, config: { version: 1, fanout: { copy: ['.env'] } } }, '/other', store, list)).toBeUndefined();
    expect(await takeCopySuggestion({ found: false }, '/none', store, async () => ['secret.key'])).toBeUndefined();
  });
});
