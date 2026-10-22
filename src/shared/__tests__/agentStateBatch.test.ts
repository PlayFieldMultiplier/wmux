import { describe, it, expect } from 'vitest';
import { AGENT_STATE_BATCH_MAX, agentStatesFor } from '../agentStateBatch';

describe('agentStatesFor (#2372)', () => {
  it('answers each distinct id once, shaped like its single-id reply', () => {
    const reads: string[] = [];
    const read = (id: string) => { reads.push(id); return { agentName: id.toUpperCase() }; };
    expect(agentStatesFor(['a', 'b', 'a'], read)).toEqual({ states: { a: { agentName: 'A' }, b: { agentName: 'B' } } });
    expect(reads).toEqual(['a', 'b']);
  });

  it('refuses anything but 1..max strings', () => {
    const read = () => ({});
    expect(() => agentStatesFor([], read)).toThrow();
    expect(() => agentStatesFor('a', read)).toThrow();
    expect(() => agentStatesFor(['a', 7], read)).toThrow();
    expect(() => agentStatesFor(Array.from({ length: AGENT_STATE_BATCH_MAX + 1 }, (_, n) => `p${n}`), read)).toThrow();
    expect(Object.keys(agentStatesFor(Array.from({ length: AGENT_STATE_BATCH_MAX }, (_, n) => `p${n}`), read).states)).toHaveLength(AGENT_STATE_BATCH_MAX);
  });

  it('an id that names an Object.prototype member is just an id', () => {
    expect(agentStatesFor(['__proto__', 'constructor'], (id) => id).states).toMatchObject({ constructor: 'constructor' });
    expect(Object.keys(agentStatesFor(['__proto__'], (id) => id).states)).toEqual(['__proto__']);
  });
});
