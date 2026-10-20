// A saved workflow as the owner reads it: its state, why it stopped in
// plain words, the last verified result, and where its card sits.
import { describe, expect, it } from 'vitest';
import { WORKFLOW_BLOCK, workflowTaskBlocked, workflowView, type BotWorkflow, type WorkflowView } from '../../../../shared/botWorkflow';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { TimelineItem } from '../botsTimeline';
import { conversationWorkflows, withWorkflows, workflowCardView } from '../botsWorkflow';

const SHA = 'a'.repeat(40);
const DM = 'dm:bot-0000000a' as ThreadId;

function workflow(p: Partial<BotWorkflow> = {}): WorkflowView {
  return workflowView({
    id: 'wf-000000000000000000000001', clientWorkflowId: 'c1', botId: 'bot-0000000a', workspaceId: 'w1', repoKey: 'github.com/o/r',
    threadId: DM, tainted: false, title: 'Ship the flag', state: 'active', revision: 3, createdAt: 1_000, updatedAt: 2_000,
    steps: [
      { title: 'Add the flag', prompt: 'p1', state: 'completed', dispatchKey: 'k1', taskId: 'wtask-1', result: { taskId: 'wtask-1', rev: 4, headSha: SHA, summary: 'Flag added', at: 1_500 } },
      { title: 'Document it', prompt: 'p2', state: 'waiting', dispatchKey: 'k2', taskId: 'wtask-2' },
    ],
    ...p,
  });
}

describe('workflowCardView', () => {
  it('a running workflow: its step and the last verified result (step, what, when)', () => {
    expect(workflowCardView(workflow())).toEqual({
      state: 'running', step: 2, total: 2, reason: null, cancelledWhileBlocked: false, canCancel: true,
      last: { step: 1, title: 'Add the flag', headSha: SHA, summary: 'Flag added', at: 1_500 },
    });
  });

  it('a step blocked on its failed task reads as that, without the task id', () => {
    const w = workflow({ state: 'blocked', steps: [workflow().steps[0], { ...workflow().steps[1], state: 'blocked', error: workflowTaskBlocked('wtask-2', 'failed') }] });
    expect(workflowCardView(w)).toMatchObject({ state: 'blocked', step: 2, reason: { kind: 'taskFailed', step: 2 }, canCancel: true });
  });

  it('a reason main words itself is kept as written', () => {
    const w = workflow({ state: 'blocked', steps: [workflow().steps[0], { ...workflow().steps[1], state: 'blocked', error: 'Worker capacity refused' }] });
    expect(workflowCardView(w).reason).toEqual({ kind: 'other', step: 2, text: 'Worker capacity refused' });
  });

  it('the owner\'s cancel: a started step keeps its worker; nothing is offered to cancel again', () => {
    const steps = workflow().steps;
    const started = workflow({ state: 'blocked', stoppedByOwner: true, steps: [steps[0], { ...steps[1], state: 'blocked', error: WORKFLOW_BLOCK.cancelled }] });
    expect(workflowCardView(started)).toMatchObject({ state: 'cancelled', reason: { kind: 'cancelled', step: 2, started: true }, canCancel: false, cancelledWhileBlocked: false });
    const pending = workflow({ state: 'blocked', stoppedByOwner: true, steps: [steps[0], { title: 'Document it', prompt: 'p2', state: 'blocked', error: WORKFLOW_BLOCK.cancelled }] });
    expect(workflowCardView(pending).reason).toEqual({ kind: 'cancelled', step: 2, started: false });
    const blockedFirst = workflow({ state: 'blocked', stoppedByOwner: true, steps: [steps[0], { ...steps[1], state: 'blocked', error: WORKFLOW_BLOCK.unknownDispatch }] });
    expect(workflowCardView(blockedFirst)).toMatchObject({ state: 'cancelled', reason: { kind: 'unknownDispatch' }, cancelledWhileBlocked: true });
  });

  it('done: no reason and no Cancel', () => {
    const steps = workflow().steps;
    const done = workflow({ state: 'completed', steps: [steps[0], { ...steps[1], state: 'completed', result: { taskId: 'wtask-2', rev: 2, mergedPr: 12, summary: '' } }] });
    expect(workflowCardView(done)).toMatchObject({ state: 'done', step: 2, reason: null, canCancel: false, last: { step: 2, mergedPr: 12 } });
  });
});

describe('conversationWorkflows and withWorkflows', () => {
  const card = (id: string, at: number, botId = 'bot-0000000a'): RoomCard => ({ version: 1, id, seq: 1, workspaceId: 'w1', threadId: DM, kind: 'opinion', at, actor: { kind: 'bot', workspaceId: 'w1', botId }, title: id });
  const msg = (id: string, at: number, continuation: boolean): TimelineItem => ({ kind: 'message', key: id, card: card(id, at), continuation, runEnd: !continuation, waiting: false });

  it('keeps the workflows of the conversation\'s threads, oldest first', () => {
    const a = workflow({ id: 'wf-00000000000000000000000a', createdAt: 5 });
    const b = workflow({ id: 'wf-00000000000000000000000b', createdAt: 1 });
    const other = workflow({ id: 'wf-00000000000000000000000c', threadId: 'group:g1' as ThreadId });
    expect(conversationWorkflows([a, other, b], 'w1', [DM]).map((w) => w.id)).toEqual([b.id, a.id]);
    expect(conversationWorkflows([a], 'w2', [DM])).toEqual([]);
  });

  it('places a card at the time it was saved, after the run it falls in', () => {
    const items = [msg('m1', 500, false), msg('m2', 900, false), msg('m3', 1_100, true), msg('m4', 3_000, false)];
    expect(withWorkflows(items, [workflow({ createdAt: 1_000 })]).map((i) => i.key)).toEqual(['m1', 'm2', 'm3', 'workflow:wf-000000000000000000000001', 'm4']);
    expect(withWorkflows([], [workflow()]).map((i) => i.kind)).toEqual(['workflow']);
  });
});
