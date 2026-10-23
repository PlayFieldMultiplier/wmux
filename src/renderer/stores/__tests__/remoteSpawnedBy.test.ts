/**
 * Remote-spawn provenance on a workspace (`fanout.spawnWorkspace` param
 * `remoteSpawnedBy`): checked strictly (a bad value is ignored), kept on the
 * workspace through a session save and load, not carried onto a duplicate,
 * and announced by a toast that never holds the prompt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import type { SessionData, Workspace } from '../../../shared/types';
import type { A2aRemoteSpawnedBy } from '../../../shared/a2aSpawn';
import {
  parseRemoteSpawnedBy,
  readRemoteSpawnedBy,
  remoteSpawnToastMessage,
} from '../../utils/remoteSpawnedBy';

const BY: A2aRemoteSpawnedBy = {
  hostId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  name: 'DESK',
  spawnId: 'sp-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  agent: 'codex',
};

function makeWorkspace(id: string, extra: Record<string, unknown> = {}): Workspace {
  return {
    id,
    name: id,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 't', shell: 'zsh', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
    ...extra,
  } as unknown as Workspace;
}

function loadWith(workspaces: Workspace[]): void {
  useStore.getState().loadSession({
    workspaces,
    activeWorkspaceId: workspaces[0]?.id,
    sidebarVisible: true,
  } as unknown as SessionData);
}

const wsById = (id: string) => useStore.getState().workspaces.find((w) => w.id === id);

beforeEach(() => {
  loadWith([makeWorkspace('ws-1'), makeWorkspace('ws-2')]);
});

describe('parseRemoteSpawnedBy', () => {
  it('takes exactly one valid value', () => {
    expect(parseRemoteSpawnedBy(BY)).toEqual(BY);
    expect(parseRemoteSpawnedBy({ ...BY, name: 'n'.repeat(64) })?.name).toHaveLength(64);
  });

  it.each([
    ['no value', undefined],
    ['null', null],
    ['an array', [BY]],
    ['a host id that is not a uuid', { ...BY, hostId: 'desk' }],
    ['an empty name', { ...BY, name: '' }],
    ['a blank name', { ...BY, name: '   ' }],
    ['a name over 64 characters', { ...BY, name: 'n'.repeat(65) }],
    ['a name that is not a string', { ...BY, name: 7 }],
    ['a spawn id without its prefix', { ...BY, spawnId: BY.spawnId.slice(3) }],
    ['an unknown agent', { ...BY, agent: 'constructor' }],
  ])('refuses %s', (_label, raw) => {
    expect(parseRemoteSpawnedBy(raw)).toBeNull();
  });
});

describe('setWorkspaceRemoteSpawnedBy', () => {
  it('marks only that workspace', () => {
    useStore.getState().setWorkspaceRemoteSpawnedBy('ws-1', BY);
    expect(readRemoteSpawnedBy(wsById('ws-1'))).toEqual(BY);
    expect(readRemoteSpawnedBy(wsById('ws-2'))).toBeUndefined();
  });

  it('survives a session save and load (the save spreads the workspace)', () => {
    useStore.getState().setWorkspaceRemoteSpawnedBy('ws-1', BY);
    const saved = JSON.parse(JSON.stringify(useStore.getState().workspaces.map((ws) => ({ ...ws })))) as Workspace[];
    loadWith(saved);
    expect(readRemoteSpawnedBy(wsById('ws-1'))).toEqual(BY);
  });

  it('drops a hand-edited value that is not exactly one, keeping the workspace', () => {
    loadWith([
      makeWorkspace('ws-1', { remoteSpawnedBy: BY }),
      makeWorkspace('ws-2', { remoteSpawnedBy: { ...BY, agent: 'nope' } }),
    ]);
    expect(readRemoteSpawnedBy(wsById('ws-1'))).toEqual(BY);
    expect(wsById('ws-2')).toBeDefined();
    expect(wsById('ws-2')).not.toHaveProperty('remoteSpawnedBy');
  });

  it('is not carried onto a duplicated workspace', () => {
    useStore.getState().setWorkspaceRemoteSpawnedBy('ws-1', BY);
    useStore.getState().duplicateWorkspace('ws-1');
    const copy = useStore.getState().workspaces.find((w) => w.id !== 'ws-1' && w.id !== 'ws-2');
    expect(copy).toBeDefined();
    expect(readRemoteSpawnedBy(copy)).toBeUndefined();
  });
});

describe('remoteSpawnToastMessage', () => {
  it('names the PC and the agent, and nothing else', () => {
    expect(remoteSpawnToastMessage(BY)).toBe('DESK started Codex CLI here');
  });

  it('has no prompt text even when one is smuggled into the value', () => {
    const smuggled = { ...BY, text: 'SECRET PROMPT' } as A2aRemoteSpawnedBy;
    expect(remoteSpawnToastMessage(parseRemoteSpawnedBy(smuggled)!)).not.toContain('SECRET PROMPT');
    expect(parseRemoteSpawnedBy(smuggled)).not.toHaveProperty('text');
  });
});
