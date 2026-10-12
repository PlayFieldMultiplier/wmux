import { describe, expect, it } from 'vitest';
import { FACT_KINDS, factDedupeKey, isFactKind, type FactKind } from '../facts';
import { parseThreadId, prThreadId, issueThreadId } from '../room';
import {
  BOT_ROLES,
  DEFAULT_BOT_BUDGETS,
  DEFAULT_BOT_ENGINE,
  botArgValue,
  botMcpArgs,
  botTokenFileArgValue,
  isBotBinding,
} from '../bot';
import { botFanoutIdempotencyKey } from '../wake';

const AT = Date.UTC(2026, 9, 12, 9, 30, 15);
const MINUTE = Math.floor(AT / 60_000);

describe('factDedupeKey', () => {
  it('builds the design keys', () => {
    const repoKey = 'openwong2kim/wmux';
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, repoKey, ref: { pr: 12 } })).toBe('pr.opened:openwong2kim/wmux#12');
    expect(factDedupeKey({ kind: 'pr.head_moved', at: AT, repoKey, ref: { pr: 12, headSha: 'abc' } }))
      .toBe('pr.head_moved:openwong2kim/wmux#12:abc');
    expect(factDedupeKey({ kind: 'ci.green', at: AT, repoKey, ref: { pr: 12, headSha: 'abc' } })).toBe('ci.green:openwong2kim/wmux#12:abc');
    expect(factDedupeKey({ kind: 'issue.labelled', at: AT, repoKey, ref: { issue: 3, label: 'bug' } }))
      .toBe('issue.labelled:openwong2kim/wmux#3:bug');
    expect(factDedupeKey({ kind: 'verdict.recorded', at: AT, repoKey, ref: { pr: 12, headSha: 'abc', botId: 'bot-0000beef' } }))
      .toBe('verdict.recorded:openwong2kim/wmux#12:abc:bot-0000beef');
    expect(factDedupeKey({ kind: 'merge.done', at: AT, repoKey, ref: { pr: 12 } })).toBe('merge.done:openwong2kim/wmux#12');
    expect(factDedupeKey({ kind: 'task.done', at: AT, ref: { taskId: 't1' } })).toBe('task.done:t1');
    expect(factDedupeKey({ kind: 'pane.idle', at: AT, ref: { ptyId: 'p1' } })).toBe(`pane.idle:p1:${MINUTE}`);
    expect(factDedupeKey({ kind: 'handoff.received', at: AT, ref: { handoffId: 'h-1' } })).toBe('handoff.received:h-1');
    expect(factDedupeKey({ kind: 'schedule.fired', at: AT, ref: { scheduleId: 'morning' } }))
      .toBe(`schedule.fired:morning:${Math.floor(AT / 86_400_000)}`);
    expect(factDedupeKey({ kind: 'bot.refused', at: AT, ref: { botId: 'bot-0000beef', method: 'input.send' } }))
      .toBe(`bot.refused:bot-0000beef:input.send:${MINUTE}`);
  });

  it('a verdict from a pane (no bot) keys on its workspace', () => {
    expect(factDedupeKey({ kind: 'verdict.recorded', at: AT, repoKey: 'a/b', workspaceId: 'ws-1', ref: { pr: 1, headSha: 'f' } }))
      .toBe('verdict.recorded:a/b#1:f:ws-1');
  });

  it('refuses (null) when the parts the kind needs are missing', () => {
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, ref: { pr: 12 } })).toBeNull();
    expect(factDedupeKey({ kind: 'pr.head_moved', at: AT, repoKey: 'a/b', ref: { pr: 12 } })).toBeNull();
    expect(factDedupeKey({ kind: 'pr.opened', at: AT, repoKey: 'a/b', ref: { pr: 0 } })).toBeNull();
    expect(factDedupeKey({ kind: 'task.done', at: AT })).toBeNull();
    expect(factDedupeKey({ kind: 'human.message', at: AT, ref: {} })).toBeNull();
    expect(factDedupeKey({ kind: 'pane.idle', at: Number.NaN, ref: { ptyId: 'p' } })).toBeNull();
  });

  it('has a key rule for every kind', () => {
    const full = { pr: 1, issue: 1, headSha: 's', taskId: 't', botId: 'b', handoffId: 'h', ptyId: 'p', label: 'l', scheduleId: 's', method: 'm', messageId: 'x' };
    for (const kind of FACT_KINDS) {
      expect(factDedupeKey({ kind, at: AT, repoKey: 'a/b', ref: full }), kind).toMatch(new RegExp(`^${kind.replace('.', '\\.')}:`));
    }
    expect(isFactKind('pr.opened')).toBe(true);
    expect(isFactKind('pr.reopened' as FactKind)).toBe(false);
  });
});

describe('thread ids', () => {
  it('accepts the thread shapes and builds pr / issue ids', () => {
    expect(parseThreadId('general')).toBe('general');
    expect(parseThreadId(prThreadId('a/b', 12))).toBe('pr:a/b#12');
    expect(parseThreadId(issueThreadId('a/b', 3))).toBe('issue:a/b#3');
    expect(parseThreadId('task:wt-1')).toBe('task:wt-1');
    expect(parseThreadId('handoff:h-01')).toBe('handoff:h-01');
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'pr:a/b#0', 'pr:ab#1', 'pr:a/b#x', 'nope:1', 'task:', 'task:a b', 42, null, `plan:${'x'.repeat(300)}`]) {
      expect(parseThreadId(bad), String(bad)).toBeNull();
    }
  });
});

describe('bot args and bindings', () => {
  it('round-trips the MCP bot args', () => {
    const args = ['/b/index.js', ...botMcpArgs('verifier', '/tmp/x.token')];
    expect(botArgValue(args)).toBe('verifier');
    expect(botTokenFileArgValue(args)).toBe('/tmp/x.token');
    expect(botArgValue(['/b/index.js', '--commander'])).toBeUndefined();
  });

  it('validates a binding', () => {
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'lead' })).toBe(true);
    expect(isBotBinding({ workspaceId: '', botId: 'bot-0a1b2c3d', role: 'lead' })).toBe(false);
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-1', role: 'lead' })).toBe(false);
    expect(isBotBinding({ workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'merge' })).toBe(false);
    expect(isBotBinding(null)).toBe(false);
  });

  it('has a default budget for every role and claude-sdk as the default engine', () => {
    for (const role of BOT_ROLES) expect(DEFAULT_BOT_BUDGETS[role].turnTimeoutMs).toBe(600_000);
    expect(DEFAULT_BOT_BUDGETS.moa.maxConcurrentWorkers).toBe(0);
    expect(DEFAULT_BOT_ENGINE).toEqual({ kind: 'claude-sdk' });
  });

  it('keys a bot fan-out by wake and ordinal', () => {
    expect(botFanoutIdempotencyKey('w1', 0)).toBe('wake:w1:0');
  });
});
