import { beforeEach, describe, expect, it } from 'vitest';
import {
  noteShellPrompt,
  resetShellPromptMirrorForTests,
  resyncShellPromptsAtConnect,
  shellPromptOf,
} from '../shellPromptMirror';

const push = { shape: 'yes-no', question: 'Push anyway? [y/N]' } as const;
const secret = { shape: 'secret' } as const;

describe('shellPromptMirror', () => {
  beforeEach(() => resetShellPromptMirrorForTests());

  it('keeps what events report, for the metadata poll to carry', () => {
    noteShellPrompt('p1', push);
    expect(shellPromptOf('p1')).toEqual(push);
    noteShellPrompt('p1', null);
    expect(shellPromptOf('p1')).toBeNull();
  });

  it('a reconnect sends a prompt already waiting, and clears one whose clear was missed', async () => {
    noteShellPrompt('stale', push);
    const sent: Array<[string, unknown]> = [];
    await resyncShellPromptsAtConnect(async () => [{ sessionId: 'p2', prompt: secret }], (id, p) => sent.push([id, p]));
    expect(sent).toEqual([['stale', null], ['p2', secret]]);
    expect(shellPromptOf('stale')).toBeNull();
    expect(shellPromptOf('p2')).toEqual(secret);
  });

  it('a daemon without the list leaves the copy as it was', async () => {
    noteShellPrompt('p1', push);
    const sent: unknown[] = [];
    await resyncShellPromptsAtConnect(async () => null, (id) => sent.push(id));
    expect(sent).toEqual([]);
    expect(shellPromptOf('p1')).toEqual(push);
  });
});
