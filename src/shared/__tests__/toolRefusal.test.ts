import { describe, expect, it } from 'vitest';
import { parseToolRefusal, refusalStopLine, toolOutcomeOfLine } from '../toolRefusal';

const AT = '2026-10-27T16:57:19.676Z';
/** A tool-result line as Claude Code 2.1.311 writes it (fields as measured; no paths). */
const result = (fields: Record<string, unknown>, content: unknown = 'x') => JSON.stringify({
  type: 'user', version: '2.1.311', timestamp: AT,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content, is_error: true }] },
  ...fields,
});

describe('toolOutcomeOfLine', () => {
  it('reads each measured refusal: a deny rule, a hook, auto mode, and the sandbox refusing a connection', () => {
    expect(toolOutcomeOfLine(result({ toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'subcommandResults', ruleSource: 'userSettings', reasonCode: 'rule:userSettings' } })))
      .toEqual({ type: 'refused', refusal: { toolUseId: 'toolu_01', kind: 'rule', source: 'config', reasonCode: 'rule:userSettings', at: Date.parse(AT) } });
    expect(toolOutcomeOfLine(result({ toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } })))
      .toMatchObject({ refusal: { kind: 'hook', reasonCode: 'hook:PreToolUse' } });
    expect(toolOutcomeOfLine(result({ toolDenialKind: 'automode-parsing-error', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode:no-verdict' } })))
      .toMatchObject({ refusal: { kind: 'auto-mode' } });
    expect(toolOutcomeOfLine(result({ permissionDecision: { decision: 'accept', source: 'config', reasonType: 'other' }, sandboxViolations: [{ kind: 'network', host: 'example.com', port: 80 }], sandboxed: true })))
      .toMatchObject({ refusal: { kind: 'sandbox-network', source: 'sandbox', reasonCode: null } });
  });

  it('a tool that ran, and the next prompt, move past a refusal', () => {
    expect(toolOutcomeOfLine(result({ permissionDecision: { decision: 'accept', source: 'config' }, sandboxViolations: [] }))).toEqual({ type: 'accepted' });
    expect(toolOutcomeOfLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'go on' } }))).toEqual({ type: 'prompt' });
    expect(toolOutcomeOfLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go on' }] } }))).toEqual({ type: 'prompt' });
  });

  it('says nothing for another line, a meta line, or fields of another shape; a result without them is unknown', () => {
    expect(toolOutcomeOfLine(JSON.stringify({ type: 'assistant', message: { content: [] } }))).toBeNull();
    expect(toolOutcomeOfLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'reminder' } }))).toBeNull();
    expect(toolOutcomeOfLine('{"type":"user", not json')).toBeNull();
    expect(toolOutcomeOfLine(result({ permissionDecision: { decision: 7 } }))).toEqual({ type: 'unknown', version: '2.1.311' });
    expect(toolOutcomeOfLine(result({}))).toEqual({ type: 'unknown', version: '2.1.311' });
    expect(toolOutcomeOfLine(result({ permissionDecision: { decision: 'ask', source: 'config' } }))).toBeNull();
  });
});

describe('parseToolRefusal', () => {
  it('takes a well-formed refusal only', () => {
    const r = { toolUseId: 'toolu_01', kind: 'hook', source: 'hook', reasonCode: 'hook:PreToolUse', at: 5 };
    expect(parseToolRefusal(r)).toEqual(r);
    expect(parseToolRefusal({ ...r, reasonCode: null })).toEqual({ ...r, reasonCode: null });
    expect(parseToolRefusal({ ...r, kind: 'bogus' })).toBeNull();
    expect(parseToolRefusal({ ...r, reasonCode: 'has space' })).toBeNull();
    expect(parseToolRefusal({ ...r, at: -1 })).toBeNull();
  });

  it('says in one line what stopped the turn', () => {
    expect(refusalStopLine({ kind: 'hook' })).toBe('stopped after a refused tool call (a hook)');
    expect(refusalStopLine({ kind: 'sandbox-network' })).toBe('stopped after the sandbox refused a network connection');
  });
});
