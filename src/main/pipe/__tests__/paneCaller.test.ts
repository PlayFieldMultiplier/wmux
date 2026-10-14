// The pane behind a pipe call is resolved from the verified senderPtyId only.
import { describe, it, expect } from 'vitest';
import type { RpcContext } from '../../../shared/rpc';
import { agentSlugOf, bodyOf, resolvePaneCaller } from '../paneCaller';

const CTX: RpcContext = { origin: 'local', clientName: 'claude-code', externalWire: true };
const deps = {
  resolvePtyWorkspace: async (pty: string) => (pty === 'pty-1' ? 'ws-1' : null),
  paneCwd: () => '/repo/wt',
};

describe('paneCaller', () => {
  it('stamps the caller from the verified pane and its cwd', async () => {
    expect(await resolvePaneCaller(deps, { senderPtyId: 'pty-1', workspaceId: 'ws-evil' }, CTX)).toEqual({
      asker: { ptyId: 'pty-1', workspaceId: 'ws-1', agent: 'claude' },
      cwd: '/repo/wt',
    });
  });

  it('is null for an unresolved pane, no pane, a commander session or a hosted workspace', async () => {
    expect(await resolvePaneCaller(deps, { senderPtyId: 'pty-9' }, CTX)).toBeNull();
    expect(await resolvePaneCaller(deps, {}, CTX)).toBeNull();
    expect(await resolvePaneCaller(deps, { senderPtyId: 'pty-1' }, { ...CTX, commanderWorkspace: 'ws-1' })).toBeNull();
    expect(await resolvePaneCaller(deps, { senderPtyId: 'pty-1' }, { ...CTX, hostedWorkspace: 'ws-1' })).toBeNull();
    const throwing = { ...deps, resolvePtyWorkspace: async () => { throw new Error('down'); } };
    expect(await resolvePaneCaller(throwing, { senderPtyId: 'pty-1' }, CTX)).toBeNull();
  });

  it('bodyOf drops the identity field the MCP layer adds', () => {
    expect(bodyOf({ senderPtyId: 'pty-1', a: 1 })).toEqual({ a: 1 });
  });

  it('agent slugs match the daemon\'s', () => {
    expect(agentSlugOf('claude-code')).toBe('claude');
    expect(agentSlugOf('codex-mcp-client')).toBe('codex');
    expect(agentSlugOf(undefined)).toBe('unknown');
  });
});
