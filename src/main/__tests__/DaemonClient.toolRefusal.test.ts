// The daemon sends each pane's refusal again on subscribe, before main has
// attached a listener to a new client: the client keeps them itself.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonClient } from '../DaemonClient';

const REFUSAL = { toolUseId: 'toolu_1', kind: 'hook', source: 'hook', reasonCode: 'hook:PreToolUse', at: 5 };

describe('DaemonClient tool refusals', () => {
  it('keeps what agent.refusal reports with no listener; null or a refusal it cannot read clears it', () => {
    const client = new DaemonClient('unused', 'token');
    const deliver = (data: unknown) => (client as unknown as { handleControlMessage(line: string): void })
      .handleControlMessage(JSON.stringify({ type: 'agent.refusal', sessionId: 'pty-1', data }));
    deliver({ refusal: REFUSAL });
    expect(client.toolRefusalOf('pty-1')).toEqual(REFUSAL);
    deliver({ refusal: { ...REFUSAL, kind: 'nope' } });
    expect(client.toolRefusalOf('pty-1')).toBeNull();
    deliver({ refusal: REFUSAL });
    deliver({ refusal: null });
    expect(client.toolRefusalOf('pty-1')).toBeNull();
  });
});
