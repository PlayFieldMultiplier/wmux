import { beforeEach, describe, expect, it } from 'vitest';
import {
  noteShellPrompt,
  replaceShellPrompts,
  resetShellPromptMirrorForTests,
  resyncShellPromptsAtConnect,
  shellPromptOf,
} from '../shellPromptMirror';

const push = { shape: 'yes-no', question: 'Push anyway? [y/N]' } as const;
const secret = { shape: 'secret' } as const;
const E = 'epoch-a';

describe('shellPromptMirror', () => {
  beforeEach(() => resetShellPromptMirrorForTests());

  it('keeps what events report, for the metadata poll to carry', () => {
    expect(noteShellPrompt('p1', { epoch: E, seq: 1, prompt: push })).toBe(true);
    expect(shellPromptOf('p1')).toEqual(push);
    expect(noteShellPrompt('p1', { epoch: E, seq: 2, prompt: null })).toBe(true);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('drops an event older than what it has', () => {
    noteShellPrompt('p1', { epoch: E, seq: 5, prompt: null });
    expect(noteShellPrompt('p1', { epoch: E, seq: 4, prompt: push })).toBe(false);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('list, then a newer clear in the same chunk: cleared', () => {
    // The list was taken at seq 5 with p1 shown; the clear at seq 6 shares its chunk.
    replaceShellPrompts({ epoch: E, seq: 5, prompts: [{ sessionId: 'p1', prompt: push, seq: 5 }] });
    expect(noteShellPrompt('p1', { epoch: E, seq: 6, prompt: null })).toBe(true);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('the same chunk applied clear first (the list waits on a promise): still cleared', () => {
    noteShellPrompt('p1', { epoch: E, seq: 5, prompt: push });
    noteShellPrompt('p1', { epoch: E, seq: 6, prompt: null });
    const changes = replaceShellPrompts({ epoch: E, seq: 5, prompts: [{ sessionId: 'p1', prompt: push, seq: 5 }] });
    expect(changes).toEqual([]);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('a prompt set after the list, applied before it, survives the list', () => {
    noteShellPrompt('p2', { epoch: E, seq: 7, prompt: secret });
    const changes = replaceShellPrompts({ epoch: E, seq: 6, prompts: [] });
    expect(changes).toEqual([]);
    expect(shellPromptOf('p2')).toEqual(secret);
  });

  it('a reconnect sends a prompt already waiting, and clears one whose clear was missed', async () => {
    noteShellPrompt('stale', { epoch: E, seq: 1, prompt: push });
    const sent: Array<[string, unknown]> = [];
    await resyncShellPromptsAtConnect(
      async () => ({ epoch: E, seq: 9, prompts: [{ sessionId: 'p2', prompt: secret, seq: 8 }] }),
      (id, p) => sent.push([id, p]),
    );
    expect(sent).toEqual([['stale', null], ['p2', secret]]);
    expect(shellPromptOf('stale')).toBeNull();
    expect(shellPromptOf('p2')).toEqual(secret);
  });

  it('a restarted daemon (another epoch) is newer even with a lower seq', async () => {
    noteShellPrompt('p1', { epoch: E, seq: 40, prompt: push });
    const sent: Array<[string, unknown]> = [];
    await resyncShellPromptsAtConnect(async () => ({ epoch: 'epoch-b', seq: 0, prompts: [] }), (id, p) => sent.push([id, p]));
    expect(sent).toEqual([['p1', null]]);
    expect(noteShellPrompt('p1', { epoch: 'epoch-b', seq: 1, prompt: secret })).toBe(true);
  });

  it('an event from a restarted daemon applies even before its list arrives', () => {
    noteShellPrompt('p1', { epoch: E, seq: 40, prompt: push });
    expect(noteShellPrompt('p1', { epoch: 'epoch-b', seq: 1, prompt: null })).toBe(true);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('a daemon without the list leaves the copy as it was', async () => {
    noteShellPrompt('p1', { epoch: E, seq: 1, prompt: push });
    const sent: unknown[] = [];
    await resyncShellPromptsAtConnect(async () => null, (id) => sent.push(id));
    expect(sent).toEqual([]);
    expect(shellPromptOf('p1')).toEqual(push);
  });
});
