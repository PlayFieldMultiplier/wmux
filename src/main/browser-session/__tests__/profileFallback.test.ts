import { describe, expect, it, vi } from 'vitest';
import { createChromeProfileUseHandler } from '../profileFallback';

function setup(fellBack: boolean, suggested?: string) {
  const store = {
    fellBackToDefault: vi.fn(() => fellBack),
    noteUsed: vi.fn(async () => undefined),
    suggestedProfile: vi.fn(() => suggested),
  };
  const noteRun = vi.fn();
  const tellWorkspace = vi.fn();
  const handle = createChromeProfileUseHandler({ store, noteRun, tellWorkspace });
  return { store, noteRun, tellWorkspace, handle };
}

describe('createChromeProfileUseHandler', () => {
  it('marks a run and tells an unbound workspace once when a call fell back to the shared default profile', () => {
    const t = setup(true, 'work');
    t.handle({ profile: 'default', workspaceId: 'ws-1', callerPtyId: 'auto-run-1' });
    t.handle({ profile: 'default', workspaceId: 'ws-1', callerPtyId: 'auto-run-1' });
    t.handle({ profile: 'default', callerPtyId: 'daemon-7' });
    expect(t.noteRun.mock.calls).toEqual([['auto-run-1']]);
    expect(t.tellWorkspace.mock.calls).toEqual([['ws-1', 'work']]);
    expect(t.store.noteUsed).not.toHaveBeenCalled();
  });

  it('says nothing for a chosen default, and remembers a named profile as last used', () => {
    const t = setup(false);
    t.handle({ profile: 'default', workspaceId: 'ws-2', callerPtyId: 'auto-run-2' });
    t.handle({ profile: 'work', workspaceId: 'ws-2' });
    t.handle({ profile: 'live', workspaceId: 'ws-2' });
    expect(t.noteRun).not.toHaveBeenCalled();
    expect(t.tellWorkspace).not.toHaveBeenCalled();
    expect(t.store.noteUsed.mock.calls).toEqual([['work']]);
  });
});
