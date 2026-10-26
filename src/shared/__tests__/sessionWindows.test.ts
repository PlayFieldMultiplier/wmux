import { describe, expect, it } from 'vitest';
import { PRIMARY_WINDOW_ID, resolveSessionWindows } from '../sessionWindows';
import type { SessionData } from '../types';

const ws = (...ids: string[]) => ids.map((id) => ({ id })) as unknown as SessionData['workspaces'];

describe('resolveSessionWindows', () => {
  it('a session without windows is one primary window with every workspace', () => {
    expect(resolveSessionWindows({ workspaces: ws('a', 'b'), activeWorkspaceId: 'b' })).toEqual([
      { id: PRIMARY_WINDOW_ID, workspaceIds: ['a', 'b'], activeWorkspaceId: 'b' },
    ]);
  });

  it('keeps each window its own workspaces and active one', () => {
    const windows = [
      { id: 'w1', workspaceIds: ['a'], activeWorkspaceId: 'a' },
      { id: 'w2', workspaceIds: ['b', 'c'], activeWorkspaceId: 'c' },
    ];
    expect(resolveSessionWindows({ workspaces: ws('a', 'b', 'c'), activeWorkspaceId: 'a', windows })).toEqual(windows);
  });

  it('an older version dropped windows: every workspace comes back in the primary window', () => {
    // New version saved two windows; the old one kept only the top-level union.
    expect(resolveSessionWindows({ workspaces: ws('a', 'b', 'c'), activeWorkspaceId: 'c', windows: undefined })).toEqual([
      { id: PRIMARY_WINDOW_ID, workspaceIds: ['a', 'b', 'c'], activeWorkspaceId: 'c' },
    ]);
  });

  it('puts every workspace in exactly one window', () => {
    const out = resolveSessionWindows({
      workspaces: ws('a', 'b', 'c', 'd'),
      activeWorkspaceId: 'a',
      windows: [
        { id: 'w1', workspaceIds: ['a', 'gone'] },
        { id: 'w2', workspaceIds: ['a', 'b'], activeWorkspaceId: 'a' },
      ],
    });
    // 'gone' is not a workspace; 'a' stays with the first window; 'c' and 'd'
    // were listed nowhere and go to the primary; w2's active moved away.
    expect(out).toEqual([
      { id: 'w1', workspaceIds: ['a', 'c', 'd'], activeWorkspaceId: 'a' },
      { id: 'w2', workspaceIds: ['b'], activeWorkspaceId: 'b' },
    ]);
  });

  it('drops unusable and duplicate window entries, and empty secondary windows', () => {
    const out = resolveSessionWindows({
      workspaces: ws('a', 'b'),
      activeWorkspaceId: 'a',
      windows: [null, 'x', { id: '' }, { id: 'w1', workspaceIds: ['a'] }, { id: 'w1', workspaceIds: ['b'] }, { id: 'w3', workspaceIds: [] }] as never,
    });
    expect(out).toEqual([{ id: 'w1', workspaceIds: ['a', 'b'], activeWorkspaceId: 'a' }]);
  });

  it('keeps the primary window even when it has no workspaces', () => {
    expect(resolveSessionWindows({ workspaces: ws(), activeWorkspaceId: '', windows: [{ id: 'w1', workspaceIds: [] }] })).toEqual([
      { id: 'w1', workspaceIds: [], activeWorkspaceId: undefined },
    ]);
  });
});
