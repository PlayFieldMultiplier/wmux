import { describe, expect, it } from 'vitest';
import { parseShellPromptChange, parseShellPromptList, parseShellPromptSignal } from '../shellPrompt';

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

describe('parseShellPromptChange / parseShellPromptList', () => {
  it('keeps a change with its version, and checks its prompt like a signal', () => {
    expect(parseShellPromptChange({ epoch: 'e', seq: 3, prompt: { shape: 'secret', question: 'Password:' } }))
      .toEqual({ epoch: 'e', seq: 3, prompt: { shape: 'secret' } });
    expect(parseShellPromptChange({ epoch: 'e', seq: 4, prompt: null })).toEqual({ epoch: 'e', seq: 4, prompt: null });
  });

  it('drops a change it cannot order', () => {
    expect(parseShellPromptChange({ shape: 'yes-no', question: 'x?' })).toBeNull();
    expect(parseShellPromptChange({ epoch: '', seq: 1, prompt: null })).toBeNull();
    expect(parseShellPromptChange({ epoch: 'e', seq: 1.5, prompt: null })).toBeNull();
  });

  it('keeps a list, dropping an entry that is malformed or newer than the list itself', () => {
    expect(parseShellPromptList({
      epoch: 'e',
      seq: 5,
      prompts: [
        { sessionId: 'p1', prompt: { shape: 'enter' }, seq: 2 },
        { sessionId: 'p2', prompt: { shape: 'nope' }, seq: 3 },
        { sessionId: 'p3', prompt: { shape: 'enter' }, seq: 6 },
        { prompt: { shape: 'enter' }, seq: 1 },
      ],
    })).toEqual({ epoch: 'e', seq: 5, prompts: [{ sessionId: 'p1', prompt: { shape: 'enter' }, seq: 2 }] });
    expect(parseShellPromptList({ prompts: [] })).toBeNull();
  });
});
