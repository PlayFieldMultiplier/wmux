import { describe, expect, it, vi } from 'vitest';
import { ChromeLauncherRegistry } from '../ChromeLauncher';
import { LIVE_CHROME_PROFILE } from '../ChromeProfileStore';

function registry() {
  return new ChromeLauncherRegistry({
    defaultDir: '/nonexistent/default-prof',
    profilesDir: '/nonexistent/profiles',
    store: { profileFor: () => LIVE_CHROME_PROFILE } as never,
  });
}

describe('ChromeLauncherRegistry — Return to me for lent Live Chrome tabs', () => {
  it('returnLiveBorrow calls the live client\'s returnBorrow for that workspace and tab', () => {
    const reg = registry();
    const live = reg.forProfile(LIVE_CHROME_PROFILE);
    const returnBorrow = vi.spyOn(live.writeScope!, 'returnBorrow').mockReturnValue(true);

    expect(reg.returnLiveBorrow('ws-1', 'T1')).toBe(true);
    expect(returnBorrow).toHaveBeenCalledWith('T1', 'ws-1');
  });

  it('a lent tab is returned once: the workspace no longer holds it afterwards', () => {
    const reg = registry();
    const scope = reg.forProfile(LIVE_CHROME_PROFILE).writeScope!;
    expect(scope.beginBorrow('T1', 'ws-1')).toBe(true);
    scope.settleBorrow('T1', 'ws-1', true);
    expect(scope.ownerOf('T1', 'ws-1')).toBe('borrowed');

    expect(reg.returnLiveBorrow('ws-1', 'T1')).toBe(true);
    expect(scope.ownerOf('T1', 'ws-1')).toBe('user');
    expect(reg.returnLiveBorrow('ws-1', 'T1')).toBe(false);
  });

  it('is a no-op, and lists nothing, before any live client exists', async () => {
    const reg = registry();
    expect(reg.returnLiveBorrow('ws-1', 'T1')).toBe(false);
    await expect(reg.listLiveBorrows('ws-1')).resolves.toEqual([]);
  });

  it('lists only the tabs lent to the workspace, not the ones wmux opened', async () => {
    const reg = registry();
    const live = reg.forProfile(LIVE_CHROME_PROFILE);
    vi.spyOn(live, 'cdpInfoTargets').mockResolvedValue([
      { surfaceId: 'A', targetId: 'A', workspaceId: 'ws-1', url: 'https://a.test/', title: 'A', owner: 'agent' },
      { surfaceId: 'T1', targetId: 'T1', workspaceId: 'ws-1', url: 'https://mail.test/', title: 'Mail', owner: 'borrowed' },
    ]);
    await expect(reg.listLiveBorrows('ws-1')).resolves.toEqual([
      { surfaceId: 'T1', title: 'Mail', url: 'https://mail.test/' },
    ]);
  });
});
