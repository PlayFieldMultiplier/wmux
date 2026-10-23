import { describe, expect, it } from 'vitest';
import { groupFleetPanes, selectFleetPanes, surfaceAttentionStatus } from '../fleet';
import type { FleetSelectorState } from '../fleet';
import type { PaneLeaf, Surface, Workspace } from '../../../../shared/types';

// A pane with no agent whose command waits on stdin (daemon/shellPrompt) is
// Needs you on the Fleet board, with its prompt row as the detail, or for a
// password only that it needs someone at the computer.

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
const shell: PaneLeaf = { id: 'p1', type: 'leaf', surfaces: [surface('s1', 'pty-1')], activeSurfaceId: 's1' };
const ws: Workspace = { id: 'ws-1', name: 'repo', rootPane: shell, activePaneId: 'p1' };

function state(shellPrompt?: FleetSelectorState['surfaceShellPrompt']): FleetSelectorState {
  return {
    workspaces: [ws],
    surfaceAgentStatus: {},
    surfaceActivity: {},
    surfaceAgent: {},
    surfacePendingQuestion: {},
    ...(shellPrompt ? { surfaceShellPrompt: shellPrompt } : {}),
  };
}

function rowOf(s: FleetSelectorState) {
  const groups = groupFleetPanes(selectFleetPanes(s), { surfaceShellPrompt: s.surfaceShellPrompt });
  return { groups, row: [...groups.needsYou, ...groups.idle][0] };
}

describe('Fleet: a shell waiting on stdin', () => {
  it('a plain shell with nothing asked stays Idle', () => {
    const { groups } = rowOf(state());
    expect(groups.needsYou).toHaveLength(0);
    expect(groups.idle).toHaveLength(1);
  });

  it('a yes/no prompt is Needs you, with the prompt row as the detail', () => {
    const s = state({ 'pty-1': { shape: 'yes-no', question: 'Push anyway? [y/N]' } });
    expect(surfaceAttentionStatus(s, 'pty-1')).toBe('awaiting_input');
    const { groups, row } = rowOf(s);
    expect(groups.needsYou).toHaveLength(1);
    expect(row).toMatchObject({ section: 'needsYou', detail: 'Push anyway? [y/N]', detailSource: 'question', detailKey: 'fleet.needsYourInput' });
  });

  it('a password prompt is Needs you at the computer, with no row of text at all', () => {
    const { groups, row } = rowOf(state({ 'pty-1': { shape: 'secret' } }));
    expect(groups.needsYou).toHaveLength(1);
    expect(row.detailKey).toBe('fleet.detail.shellSecret');
    expect(row.detail).toBeUndefined();
  });

  it('cleared, the pane is Idle again', () => {
    const { groups } = rowOf(state({}));
    expect(groups.needsYou).toHaveLength(0);
  });
});
