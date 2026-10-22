// A task started from a 1:1 or a group chat: its worker's lifecycle cards
// go to the task's own thread, linking the conversation, so the room's
// summary names that conversation and the conversation folds the task
// thread into one work card instead of a line per pause, resume and end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomWriter } from '../roomWriter';
import { splitThreads, startedThreadsOf, threadKey } from '../../../shared/botsWork';
import { taskLifecycleLinkOf, taskLifecycleThreadOf, type ThreadId } from '../../../shared/room';

const TASK = 'wtask-abc-12345678';
const GROUP = 'group:grp-0000abcd' as ThreadId;
const BOT = 'bot-0000000a';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-lifecycle-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('taskLifecycleThreadOf', () => {
  it('moves a 1:1\'s or a group\'s task to task:<id> and links it; a PR thread or none stays', () => {
    const of = (threadId?: string) => ({ id: TASK, dispatch: threadId ? { threadId } : {} });
    expect(taskLifecycleThreadOf(of(GROUP))).toBe(`task:${TASK}`);
    expect(taskLifecycleLinkOf(of(GROUP))).toBe(GROUP);
    expect(taskLifecycleThreadOf(of(`dm:${BOT}`))).toBe(`task:${TASK}`);
    expect(taskLifecycleLinkOf(of(`dm:${BOT}`))).toBe(`dm:${BOT}`);
    expect(taskLifecycleThreadOf(of('pr:github.com/acme/app#12'))).toBe('pr:github.com/acme/app#12');
    expect(taskLifecycleLinkOf(of('pr:github.com/acme/app#12'))).toBeUndefined();
    expect(taskLifecycleThreadOf(of())).toBe(`task:${TASK}`);
    expect(taskLifecycleLinkOf(of())).toBeUndefined();
  });

  it('the group folds the task thread into one work card: none of its lifecycle cards is a line', () => {
    let now = 1_000;
    const rooms = new RoomWriter({ dir: path.join(dir, 'rooms'), now: () => now, log: () => undefined });
    const where = taskLifecycleThreadOf({ id: TASK, dispatch: { threadId: GROUP } });
    const link = taskLifecycleLinkOf({ id: TASK, dispatch: { threadId: GROUP } });
    rooms.append({ workspaceId: 'ws1', threadId: GROUP, kind: 'human', actor: { kind: 'human' }, title: 'Add a flag' });
    for (const title of ['Worker paused (resumable): flag', 'Worker resumed: flag', 'Worker done (resumable): flag']) {
      now += 1_000;
      rooms.append({ workspaceId: 'ws1', threadId: where, kind: 'fact', actor: { kind: 'system' }, title, refs: { taskId: TASK, ...(link ? { threadId: link } : {}) } });
    }
    const summaries = rooms.threads('ws1');
    expect(summaries.find((s) => s.threadId === where)?.groupId).toBe('grp-0000abcd');
    const cards = rooms.read('ws1').cards;
    const started = startedThreadsOf({ threadId: GROUP }, cards, { ws1: summaries });
    expect(started.has(threadKey('ws1', where))).toBe(true);
    const split = splitThreads(cards, () => false, started);
    // The owner's message and the work card's anchor: one item for the task.
    expect(split.main.map((c) => c.title)).toEqual(['Add a flag', 'Worker paused (resumable): flag']);
    expect([...split.work.values()][0].steps).toHaveLength(3);
  });
});
