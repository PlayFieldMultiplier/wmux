import { describe, expect, it } from 'vitest';
import { approvedRoleBindings, fanoutTaskRoleBinding } from '../fanoutPreset';

describe('approvedRoleBindings', () => {
  it('holds each requested role once, its binding normalized, or null when it is shown as unbound', () => {
    const bindings = {
      Builder: { agent: 'codex', model: 'o3', bogus: 1 },
      Reviewer: {},
      Planner: { agent: 'claude' },
    };
    expect(approvedRoleBindings(['Builder', 'Reviewer', 'Builder', '', 'Tester', 7], bindings)).toEqual({
      Builder: { agent: 'codex', model: 'o3' },
      Reviewer: null,
      Tester: null,
    });
    expect(approvedRoleBindings(['Builder'], 'not an object')).toEqual({ Builder: null });
  });
});

describe('fanoutTaskRoleBinding', () => {
  const current = { agent: 'claude', model: 'sonnet' };
  it('launches the approved binding, not one the role was rebound to since', () => {
    expect(fanoutTaskRoleBinding({ roleBinding: { agent: 'codex', model: 'o3' } }, current)).toEqual({ agent: 'codex', model: 'o3' });
    // Approved as unbound stays unbound.
    expect(fanoutTaskRoleBinding({ roleBinding: null }, current)).toBeUndefined();
  });

  it('reads the current binding for a launch with no approval behind it', () => {
    expect(fanoutTaskRoleBinding({}, current)).toBe(current);
  });
});
