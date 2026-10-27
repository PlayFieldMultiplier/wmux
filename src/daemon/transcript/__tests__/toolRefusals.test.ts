import { describe, expect, it } from 'vitest';
import type { ToolRefusal } from '../../../shared/toolRefusal';
import { ToolRefusalTracker } from '../toolRefusals';

const reject = (id: string, version = '2.1.311') => JSON.stringify({
  type: 'user', version, timestamp: '2026-10-27T16:57:19.676Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' },
});
const accept = (id: string) => JSON.stringify({
  type: 'user', version: '2.1.311', message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  permissionDecision: { decision: 'accept', source: 'config' },
});
const prompt = JSON.stringify({ type: 'user', message: { content: 'next' } });
const bare = (version: string) => JSON.stringify({ type: 'user', version, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x' }] } });

function rig() {
  const sent: Array<[string, string | null]> = [];
  const logs: string[] = [];
  const t = new ToolRefusalTracker({ emit: (id, r: ToolRefusal | null) => sent.push([id, r?.toolUseId ?? null]), log: (l) => logs.push(l) });
  return { t, sent, logs };
}

describe('ToolRefusalTracker', () => {
  it('holds a refusal past the turn until a tool runs or the next prompt, and sends only changes', () => {
    const { t, sent } = rig();
    t.noteLine('p1', '/t/a.jsonl', reject('toolu_1'));
    t.noteLine('p1', '/t/a.jsonl', reject('toolu_1'));
    expect(t.get('p1')?.kind).toBe('hook');
    t.noteLine('p1', '/t/a.jsonl', accept('toolu_2'));
    t.noteLine('p1', '/t/a.jsonl', reject('toolu_3'));
    t.noteLine('p1', '/t/a.jsonl', prompt);
    expect(sent).toEqual([['p1', 'toolu_1'], ['p1', null], ['p1', 'toolu_3'], ['p1', null]]);
  });

  it('starts afresh on another transcript and when the pane is gone; resync sends what it holds', () => {
    const { t, sent } = rig();
    t.noteLine('p1', '/t/a.jsonl', reject('toolu_1'));
    t.noteLine('p1', '/t/b.jsonl', prompt.replace('next', 'hi'));
    expect(t.get('p1')).toBeNull();
    t.noteLine('p2', '/t/c.jsonl', reject('toolu_9'));
    t.resync();
    t.drop('p2');
    expect(sent).toEqual([['p1', 'toolu_1'], ['p1', null], ['p2', 'toolu_9'], ['p2', 'toolu_9'], ['p2', null]]);
  });

  it('a result without the decision fields says nothing, and from a version that writes them, logs once', () => {
    const { t, sent, logs } = rig();
    t.noteLine('p1', '/t/a.jsonl', reject('toolu_1'));
    t.noteLine('p1', '/t/a.jsonl', bare('2.1.200'));
    expect(logs).toEqual([]);
    t.noteLine('p1', '/t/a.jsonl', bare('2.1.400'));
    t.noteLine('p1', '/t/a.jsonl', bare('2.2.0'));
    expect(logs).toHaveLength(1);
    expect(t.get('p1')?.toolUseId).toBe('toolu_1');
    expect(sent).toEqual([['p1', 'toolu_1']]);
  });
});
