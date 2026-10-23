import { describe, expect, it } from 'vitest';
import { parseShellPromptSignal } from '../shellPrompt';

describe('parseShellPromptSignal', () => {
  it('keeps a known shape and its cleaned question', () => {
    expect(parseShellPromptSignal({ shape: 'yes-no', question: ' Continue? [y/N]\x07 ' })).toEqual({ shape: 'yes-no', question: 'Continue? [y/N]' });
    expect(parseShellPromptSignal({ shape: 'enter' })).toEqual({ shape: 'enter' });
  });

  it('a secret never keeps a question, whatever was sent', () => {
    expect(parseShellPromptSignal({ shape: 'secret', question: 'Password for me:' })).toEqual({ shape: 'secret' });
  });

  it('anything else is null', () => {
    expect(parseShellPromptSignal(null)).toBeNull();
    expect(parseShellPromptSignal({ shape: 'other', question: 'x' })).toBeNull();
    expect(parseShellPromptSignal('yes-no')).toBeNull();
  });
});
