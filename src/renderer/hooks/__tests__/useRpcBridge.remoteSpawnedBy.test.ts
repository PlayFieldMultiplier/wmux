import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../../test-utils/sourceText';

/**
 * `fanout.spawnWorkspace` param `remoteSpawnedBy` (remote spawn).
 *
 * `handleRpcMethod` cannot be imported under vitest (see
 * useRpcBridge.fanoutRole.test.ts), so this pins the wiring: the value is
 * checked by parseRemoteSpawnedBy (tested in stores/__tests__/remoteSpawnedBy),
 * a bad one never fails the spawn, the mark lands on the new workspace before
 * anything awaits, and the toast fires only once the pane is in.
 */
describe('useRpcBridge — fanout.spawnWorkspace remoteSpawnedBy', () => {
  const src = readSourceText(path.join(__dirname, '..', 'useRpcBridge.ts'));
  const block = (() => {
    const m = src.match(/if \(method === 'fanout\.spawnWorkspace'\)[\s\S]*?\n {2}\}\n/);
    if (!m) throw new Error('fanout.spawnWorkspace handler not found');
    return m[0];
  })();
  const at = (re: RegExp): number => {
    const i = block.search(re);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('checks the param and never turns a bad one into an error', () => {
    expect(block).toMatch(/const remoteSpawnedBy = parseRemoteSpawnedBy\(params\.remoteSpawnedBy\);/);
    expect(block).not.toMatch(/remoteSpawnedBy[^\n]*return \{ error/);
  });

  it('marks the new workspace right after it exists, before pty.create', () => {
    const order = [
      /store\.addWorkspace\(name\)/,
      /afterAdd\.setWorkspaceRemoteSpawnedBy\(newWsId, remoteSpawnedBy\)/,
      /window\.electronAPI\.pty\.create\(/,
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('toasts once the pane holds the agent, and only from the checked value', () => {
    expect(at(/pushToast\(\{ level: 'info', message: remoteSpawnToastMessage\(remoteSpawnedBy\) \}\)/)).toBeGreaterThan(
      at(/afterPty\.addSurface\(paneId, ptyId, '', cwd, newWsId\)/),
    );
    expect(block.match(/pushToast/g)).toHaveLength(1);
  });

  it('hands back the new pane id with the workspace and pty (the link endpoint)', () => {
    expect(block).toMatch(/return \{ workspaceId: newWsId, ptyId, paneId, initialCommand: launchCommand,/);
  });
});
