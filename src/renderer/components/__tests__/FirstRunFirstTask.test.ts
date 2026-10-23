import { describe, it, expect } from 'vitest';
import { firstTaskOutcome, firstTaskPrimary, firstTaskText, folderStatusOf } from '../FirstRunFirstTask';
import { t } from '../../i18n';
import type { RoomCard } from '../../../shared/room';

const card = (seq: number, actor: RoomCard['actor'], over: Partial<RoomCard> = {}): RoomCard => ({
  version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: 'dm:b1', kind: actor.kind === 'human' ? 'human' : 'report',
  at: seq, actor, title: `card ${seq}`, ...over,
});
const bot = (botId: string) => ({ kind: 'bot', workspaceId: 'w1', botId }) as const;

describe('firstTaskOutcome', () => {
  it('is the first card by the bot after the task card, never the task card or an earlier one', () => {
    const cards = [card(1, bot('b1')), card(2, { kind: 'human' }), card(3, bot('b2')), card(4, bot('b1'), { title: 'answer' })];
    expect(firstTaskOutcome(cards, 'b1', 2)).toEqual({ kind: 'answer', card: cards[3] });
    expect(firstTaskOutcome(cards.slice(0, 3), 'b1', 2)).toBeNull();
  });

  it('reads a refusal or a budget stop after the task as an error', () => {
    expect(firstTaskOutcome([card(3, bot('b1'), { kind: 'refusal' })], 'b1', 2)?.kind).toBe('error');
    expect(firstTaskOutcome([card(3, { kind: 'system' }, { kind: 'budget' })], 'b1', 2)?.kind).toBe('error');
    expect(firstTaskOutcome([card(3, { kind: 'system' }, { kind: 'fact' })], 'b1', 2)).toBeNull();
  });
});

describe('first task helpers', () => {
  it('both example tasks only read', () => {
    expect(firstTaskText('explain', t)).toMatch(/Don't change any files\.$/);
    expect(firstTaskText('readme', t)).toMatch(/show it to me in the chat; don't write files\.$/);
  });

  it('maps the folder check to the row status', () => {
    expect(folderStatusOf({ ok: true, root: '/r', displayRoot: '~/r', repoKey: 'o/r' })).toBe('ok');
    expect(folderStatusOf({ ok: false, code: 'no_remote', message: '' })).toBe('no_remote');
    expect(folderStatusOf({ ok: false, code: 'not_a_repo', message: '' })).toBe('not_a_repo');
    expect(folderStatusOf({ ok: false, code: 'invalid_argument', message: '' })).toBe('not_a_repo');
  });

  it('offers Send only when idle and sendable; in flight is busy; answered offers Open', () => {
    expect(firstTaskPrimary('idle', true)).toBe('send');
    expect(firstTaskPrimary('idle', false)).toBe('none');
    expect(firstTaskPrimary('consent', false)).toBe('busy');
    expect(firstTaskPrimary('waiting', false)).toBe('busy');
    expect(firstTaskPrimary('answered', false)).toBe('open');
    expect(firstTaskPrimary('late', false)).toBe('open');
    expect(firstTaskPrimary('error', false)).toBe('none');
  });
});
