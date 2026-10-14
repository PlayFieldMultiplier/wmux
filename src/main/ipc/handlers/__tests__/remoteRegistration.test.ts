import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() }, app: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() } }));

import { registerRemoteSurfaces } from '../remoteRegistration';

describe('registerRemoteSurfaces', () => {
  it('registers the attach handlers and the PC rail feeds over the same stores', () => {
    const store = { id: 'hosts' } as never;
    const attachments = { id: 'attachments' } as never;
    const disposeRemote = vi.fn();
    const disposePcRail = vi.fn();
    const registerRemote = vi.fn(() => disposeRemote);
    const registerPcRail = vi.fn(() => disposePcRail);
    const dispose = registerRemoteSurfaces({ store, attachments }, { registerRemote, registerPcRail } as never);
    expect(registerRemote).toHaveBeenCalledWith(expect.objectContaining({ store, attachments }));
    expect(registerPcRail).toHaveBeenCalledWith(expect.objectContaining({ store, attachments }));
    const remoteArgs = registerRemote.mock.calls[0] as unknown as [{ store: unknown; attachments: unknown; fetchImpl: unknown }];
    const railArgs = registerPcRail.mock.calls[0] as unknown as [{ store: unknown; attachments: unknown; fetchImpl: unknown }];
    expect(railArgs[0].store).toBe(remoteArgs[0].store);
    expect(railArgs[0].attachments).toBe(remoteArgs[0].attachments);
    // One SSH-aware fetch for both surfaces, so an SSH host is reachable from either.
    expect(typeof remoteArgs[0].fetchImpl).toBe('function');
    expect(railArgs[0].fetchImpl).toBe(remoteArgs[0].fetchImpl);
    dispose();
    expect(disposePcRail).toHaveBeenCalled();
    expect(disposeRemote).toHaveBeenCalled();
  });

  it('main registers the remote surfaces through this helper', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.ts'), 'utf-8');
    expect(source).toMatch(/registerRemoteSurfaces\(\{\s*store: new RemoteHostsStore\(/);
    expect(source).not.toMatch(/^registerRemoteHandlers\(/m);
  });
});
