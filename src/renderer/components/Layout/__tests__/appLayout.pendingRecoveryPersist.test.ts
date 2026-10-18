/**
 * #2398 — a dead pane's staged recovery survives an app restart.
 *
 * The descriptor used to live only in a store map, while the session file
 * wrote the surface with `ptyId: ''`: a restart before the pane was shown lost
 * the source session, the WSL target, both cwd candidates and the resume
 * binding, and the pane came back as a plain shell in the profile directory.
 * It now rides on the surface. This runs the production serializer
 * (AppLayout's cloneWithScrollback, transpiled out the way
 * appLayout.sessionSaveInvariants does) and the real loadSession.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { useStore } from '../../../stores';
import { createWorkspace, type Pane, type PaneLeaf, type Surface, type Workspace } from '../../../../shared/types';

const source = fs.readFileSync(path.join(__dirname, '..', 'AppLayout.tsx'), 'utf-8');

function serializer(): (pane: Pane, dumped: Map<string, boolean>) => Pane {
  const tree = ts.createSourceFile('AppLayout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = tree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'cloneWithScrollback',
  );
  expect(fn, 'cloneWithScrollback declaration not found').toBeDefined();
  const code = ts.transpileModule(fn!.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('isDaemonModeActive', `${code}; return cloneWithScrollback;`)(() => true);
}

const binding = { agent: 'claude', sessionId: '0b7d9c2e-1f3a-4c5d-8e9f-a0b1c2d3e4f5', cwd: '/home/me/repo', ts: 1 };

function saveAndLoad(ws: Workspace): Surface | undefined {
  const saved = JSON.parse(JSON.stringify({ ...ws, rootPane: serializer()(ws.rootPane, new Map()) }));
  useStore.getState().loadSession({ workspaces: [saved], activeWorkspaceId: saved.id } as never);
  const loaded = useStore.getState().workspaces.find((w) => w.id === ws.id)?.rootPane as PaneLeaf | undefined;
  return loaded?.surfaces[0];
}

function savedAndLoaded(surface: Surface): Surface | undefined {
  const ws: Workspace = createWorkspace('restart');
  const leaf = ws.rootPane as PaneLeaf;
  leaf.surfaces = [surface];
  leaf.activeSurfaceId = surface.id;
  return saveAndLoad(ws);
}

describe('surface.pendingRecovery across save and load (#2398)', () => {
  it('a recovery the reconcile staged is in the saved session, and comes back', () => {
    const ws: Workspace = createWorkspace('restart');
    const leaf = ws.rootPane as PaneLeaf;
    leaf.surfaces = [{ id: 'surf-0', ptyId: 'pty-dead', title: 'wsl', shell: 'wsl.exe', cwd: '' }];
    leaf.activeSurfaceId = 'surf-0';
    useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
    const recovery = { sourceSessionId: 'pty-dead', spawnCwd: '/home/me/repo', wslTarget: { distribution: 'Ubuntu', user: 'me' } };
    // What the reconcile does for a session the daemon confirmed dead.
    useStore.getState().stageDeadPaneRecovery('surf-0', recovery, 'pty-dead');
    useStore.getState().updateSurfacePtyId(leaf.id, 'surf-0', '');
    const live = useStore.getState().workspaces.find((w) => w.id === ws.id)!;
    const loaded = saveAndLoad(live);
    expect(loaded?.ptyId).toBe('');
    expect(loaded?.pendingRecovery).toEqual(recovery);
  });

  it('keeps the source session, WSL target, cwd candidates and resume binding', () => {
    const recovery = {
      sourceSessionId: 'daemon-0652e7f0',
      wslTarget: { distribution: 'Ubuntu', user: 'me' },
      spawnCwd: '/home/me/repo',
      cwd: '/home/me/repo/src',
      resumeAgent: 'claude' as const,
      resumeBinding: binding,
    };
    const loaded = savedAndLoaded({ id: 'surf-1', ptyId: '', title: 'wsl', shell: 'wsl.exe', cwd: '', pendingRecovery: recovery });
    expect(loaded?.ptyId).toBe('');
    expect(loaded?.pendingRecovery).toEqual(recovery);
  });

  it('keeps an empty descriptor: its presence alone marks a dead-session replacement', () => {
    const loaded = savedAndLoaded({ id: 'surf-2', ptyId: '', title: 'pwsh', shell: 'pwsh', cwd: '', pendingRecovery: {} });
    expect(loaded?.pendingRecovery).toEqual({});
  });

  it('re-validates a hand-edited descriptor on load', () => {
    const hostile = {
      sourceSessionId: 42,
      args: ['--exec', 'cmd.exe'],
      wslTarget: { distribution: '--help', user: 'me' },
      spawnCwd: '   ',
      cwd: 'D:\\ok',
      resumeAgent: 'bogus',
      resumeBinding: { agent: 'claude', sessionId: '', cwd: '' },
    };
    const loaded = savedAndLoaded({ id: 'surf-3', ptyId: '', title: 'pwsh', shell: 'pwsh', cwd: '', pendingRecovery: hostile as never });
    expect(loaded?.pendingRecovery).toEqual({ cwd: 'D:\\ok' });
  });

  it('drops a descriptor that is not an object', () => {
    const loaded = savedAndLoaded({ id: 'surf-4', ptyId: '', title: 'pwsh', shell: 'pwsh', cwd: '', pendingRecovery: 'x' as never });
    expect(loaded && 'pendingRecovery' in loaded).toBe(false);
  });
});
