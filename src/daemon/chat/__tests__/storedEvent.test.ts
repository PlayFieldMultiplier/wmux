import { describe, expect, it } from 'vitest';
import { validStoredEvent } from '../storedEvent';

// The schema is built on first use; these cover that it still accepts and
// rejects exactly what the eager version did.
describe('validStoredEvent', () => {
  it('accepts each stored event kind', () => {
    expect(validStoredEvent({ id: 'e1', kind: 'user_text', text: 'hi' })).toBe(true);
    expect(validStoredEvent({ id: 'e2', kind: 'assistant_text', text: 'ok', codeBlocks: [{ n: 1, lines: 3 }] })).toBe(true);
    expect(validStoredEvent({ id: 'e3', kind: 'tool_use', toolUseId: 't', name: 'Read', argSummary: 'a', input: { n: 1, bytes: 2 } })).toBe(true);
    expect(validStoredEvent({ id: 'e4', kind: 'tool_result', toolUseId: 't', ok: true, bytes: 0, files: [{ path: 'a', patch: '' }] })).toBe(true);
    expect(validStoredEvent({ id: 'e5', kind: 'meta', subtype: 's', label: 'l' })).toBe(true);
  });

  it('rejects malformed records, and keeps rejecting after the first call', () => {
    expect(validStoredEvent({ id: '', kind: 'user_text', text: 'hi' })).toBe(false);
    expect(validStoredEvent({ id: 'e1', kind: 'unknown' })).toBe(false);
    expect(validStoredEvent({ id: 'e1', kind: 'tool_result', toolUseId: 't', ok: 'yes', bytes: 0 })).toBe(false);
    expect(validStoredEvent(null)).toBe(false);
    expect(validStoredEvent({ id: 'e1', kind: 'user_text', text: 'hi' })).toBe(true);
  });
});
