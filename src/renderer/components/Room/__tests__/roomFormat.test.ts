// What the owner reads of a card or a thread: names, never internal ids,
// role tags or machine codes.
import { describe, expect, it } from 'vitest';
import type { RoomCard } from '../../../../shared/room';
import { ownerCardText, requestTitles, routineCardBody, threadLabel, withoutInternalIds, withoutReasonCodes, withoutRoleTags } from '../roomFormat';

const t = (key: string) => key;
const system = { kind: 'system' as const };
const bot = { kind: 'bot' as const, workspaceId: 'w1', botId: 'bot-0000000a' };
const base = (over: Partial<RoomCard>): Pick<RoomCard, 'kind' | 'title' | 'body' | 'actor'> => ({ kind: 'fact', title: '', actor: system, ...over });

describe('threadLabel', () => {
  it('keeps a PR or issue reference, names a task by its title, else by its kind word', () => {
    expect(threadLabel('general', t)).toBe('room.thread.general');
    expect(threadLabel('pr:github.com/acme/app#1', t)).toBe('acme/app#1');
    expect(threadLabel('issue:github.com/acme/app#7', t)).toBe('acme/app#7');
    expect(threadLabel('task:wtask-abc', t, (id) => (id === 'wtask-abc' ? 'README title' : null))).toBe('README title');
    expect(threadLabel('task:wtask-other', t, () => null)).toBe('room.thread.task');
    expect(threadLabel('task:wtask-blank', t, () => '  ')).toBe('room.thread.task');
    expect(threadLabel('handoff:h-mv6si', t)).toBe('room.thread.handoff');
    expect(threadLabel('plan:p-1', t)).toBe('room.thread.plan');
    expect(threadLabel('report:r-1', t)).toBe('room.thread.report');
  });

  it('names a request thread by the owner\'s words that opened it, else "Request"', () => {
    const card = (over: Partial<RoomCard>): RoomCard => ({ version: 1, id: 'x', seq: 1, workspaceId: 'w1', threadId: 'general', kind: 'fact', at: 1, actor: system, title: '', ...over });
    const cards = [
      card({ id: 'c-owner', kind: 'human', actor: { kind: 'human' }, title: '  Add a --version flag to calc.py ' }),
      card({ id: 'c-hop', threadId: 'handoff:h-1', title: 'dispatch → Research: Ship it', refs: { handoffId: 'h-1', requestCardId: 'c-owner' } }),
      // A link to a card that is not the owner's names nothing.
      card({ id: 'c-bot', actor: bot, title: 'I did it' }),
      card({ id: 'c-hop2', threadId: 'handoff:h-2', title: 'dispatch → Research: Other', refs: { requestCardId: 'c-bot' } }),
    ];
    const titles = requestTitles(cards);
    expect([...titles]).toEqual([['handoff:h-1', 'Add a --version flag to calc.py']]);
    const of = (id: string) => titles.get(id as never) ?? null;
    expect(threadLabel('handoff:h-1', t, undefined, of)).toBe('Add a --version flag to calc.py');
    expect(threadLabel('handoff:h-2', t, undefined, of)).toBe('room.thread.handoff');
  });
});

describe('owner text', () => {
  it('a routine card shows its schedule, not the instructions the bot gave itself', () => {
    expect(routineCardBody('every 30 min\n\nissue_read로 열린 이슈를 읽고 bot-556702fb에 넘겨라.')).toBe('every 30 min');
    expect(routineCardBody(undefined)).toBe('');
    expect(ownerCardText(base({ kind: 'routine', actor: bot, title: 'Routine created: 새 이슈 확인', body: 'every 30 min\n\nprompt' }), []))
      .toEqual({ title: 'Routine created: 새 이슈 확인', body: 'every 30 min' });
  });

  it('a refusal keeps its plain sentences and drops the codes after them; a line that is only a code stays', () => {
    const body = '- The repository has no required checks `required-checks-green:no-required-checks`\n- GitHub listed no changed files `not-release-pr:no-files` `gate-definition-changed:no-files`\n- `odd-code`';
    expect(withoutReasonCodes(body)).toBe('- The repository has no required checks\n- GitHub listed no changed files\n- `odd-code`');
    expect(ownerCardText(base({ kind: 'refusal', title: 'Merge refused for #1', body }), []).body).not.toContain('no-required-checks');
    // Inline code inside a sentence, or a plain word, is not a reason code.
    expect(withoutReasonCodes('Run `npm test` again')).toBe('Run `npm test` again');
    expect(withoutReasonCodes('The protected branch `main` cannot be updated with `git`.')).toBe('The protected branch `main` cannot be updated with `git`.');
    expect(withoutReasonCodes('Push it with `git`')).toBe('Push it with `git`');
    expect(withoutReasonCodes('Lane auto-merge is off `lane-paused`')).toBe('Lane auto-merge is off');
  });

  it('drops a role tag after a bot\'s name in what main wrote, never in a bot\'s own words', () => {
    expect(withoutRoleTags('Answered → Wmux Dev (lead): Push?', ['Wmux Dev'])).toBe('Answered → Wmux Dev: Push?');
    expect(withoutRoleTags('Ask Wmux Dev (maybe later)', ['Wmux Dev'])).toBe('Ask Wmux Dev (maybe later)');
    expect(withoutRoleTags('Someone (lead) said', ['Wmux Dev'])).toBe('Someone (lead) said');
    expect(withoutRoleTags('A.b (verifier)', ['A.b'])).toBe('A.b');
    expect(ownerCardText(base({ title: 'Answered → Wmux Dev (lead): Q', body: 'to Wmux Dev (lead)' }), ['Wmux Dev'])).toEqual({ title: 'Answered → Wmux Dev: Q', body: 'to Wmux Dev' });
    expect(ownerCardText(base({ kind: 'status', actor: bot, title: 'I am Wmux Dev (lead)' }), ['Wmux Dev']).title).toBe('I am Wmux Dev (lead)');
  });

  it('a bot\'s words show the ids it cites as what they stand for; code blocks and unknown ids stay', () => {
    const labels = {
      taskTitle: (id: string) => (id === 'wtask-mv6yznk5-tv3qhcng' ? 'Verify PR #1' : null),
      approval: (id: string) => (id === 'apr-NQMvlIDZu05W' ? 'PR #2 approval' : null),
    };
    expect(withoutInternalIds('검증 작업 `wtask-mv6yznk5-tv3qhcng`: lint 통과', labels)).toBe('검증 작업 Verify PR #1: lint 통과');
    expect(withoutInternalIds('머지 승인 카드(apr-NQMvlIDZu05W)를 올렸습니다', labels)).toBe('머지 승인 카드(PR #2 approval)를 올렸습니다');
    expect(withoutInternalIds('thread task:wtask-mv6yznk5-tv3qhcng and pr:github.com/acme/app#2, issue:acme/app#7', labels)).toBe('thread Verify PR #1 and PR #2, issue #7');
    // An id nothing resolves, and a longer token that only contains one, stay.
    expect(withoutInternalIds('task wtask-abc-unknown1 and apr-zzzzzzzzzz', labels)).toBe('task wtask-abc-unknown1 and apr-zzzzzzzzzz');
    expect(withoutInternalIds('branch wtask-mv6yznk5-tv3qhcng-x', labels)).toBe('branch wtask-mv6yznk5-tv3qhcng-x');
    // Inline code with more in it, and fenced blocks, are left as written.
    expect(withoutInternalIds('run `git log wtask-mv6yznk5-tv3qhcng`', labels)).toBe('run `git log wtask-mv6yznk5-tv3qhcng`');
    const fenced = '```\nwtask-mv6yznk5-tv3qhcng apr-NQMvlIDZu05W\n```\nsee wtask-mv6yznk5-tv3qhcng';
    expect(withoutInternalIds(fenced, labels)).toBe('```\nwtask-mv6yznk5-tv3qhcng apr-NQMvlIDZu05W\n```\nsee Verify PR #1');
    // A fence closes only at a line of its own: backticks inside a code line
    // do not end it, and an unclosed fence runs to the end.
    const inner = '```\necho "```" wtask-mv6yznk5-tv3qhcng\n```\nok wtask-mv6yznk5-tv3qhcng\n  ```sh\napr-NQMvlIDZu05W';
    expect(withoutInternalIds(inner, labels)).toBe('```\necho "```" wtask-mv6yznk5-tv3qhcng\n```\nok Verify PR #1\n  ```sh\napr-NQMvlIDZu05W');
    // Only a bot's own words, and only with labels.
    const card = base({ kind: 'status', actor: bot, title: 'apr-NQMvlIDZu05W', body: 'task `wtask-mv6yznk5-tv3qhcng`' });
    expect(ownerCardText(card, [], labels)).toEqual({ title: 'PR #2 approval', body: 'task Verify PR #1' });
    expect(ownerCardText(card, [])).toEqual({ title: 'apr-NQMvlIDZu05W', body: 'task `wtask-mv6yznk5-tv3qhcng`' });
    expect(ownerCardText(base({ title: 'apr-NQMvlIDZu05W' }), [], labels).title).toBe('apr-NQMvlIDZu05W');
  });
});
