// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installWindowGlass } from '../windowGlass';

// Windows: the renderer gate follows the preload's build number, and the
// level reaches main so it can switch the acrylic material at runtime.

const setAppearance = vi.fn();
const setGlass = vi.fn();

function mount(level: string, bgBase: string, windowsBuildNumber: number | null, systemDark: boolean): () => void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    windowsBuildNumber,
    window: { setAppearance, setGlass },
  };
  window.matchMedia = ((query: string) => ({
    matches: systemDark, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  const root = document.documentElement;
  root.style.setProperty('--bg-base', bgBase);
  root.style.setProperty('--text-sub', '#c2bdc9');
  root.setAttribute('data-glass-level', level);
  return installWindowGlass(root);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setAppearance.mockReset();
  setGlass.mockReset();
  const root = document.documentElement;
  root.removeAttribute('data-glass');
  root.removeAttribute('data-glass-level');
  root.removeAttribute('style');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('installWindowGlass on Windows 11 22H2+', () => {
  it('sets the appearance, marks glass and sends the level with the solid overlay pair', () => {
    const stop = mount('soft', '#1A171D', 26200, true);
    expect(setAppearance).toHaveBeenCalledWith('dark');
    expect(document.documentElement.getAttribute('data-glass')).toBe('dark');
    expect(setGlass).toHaveBeenCalledTimes(1);
    expect(setGlass).toHaveBeenCalledWith({ level: 'soft', color: '#1a171d', symbolColor: '#c2bdc9' });
    stop();
  });

  it('sends Off at runtime and hands the appearance back to the system', async () => {
    const stop = mount('clear', '#FFFFFF', 26200, false);
    expect(document.documentElement.getAttribute('data-glass')).toBe('light');
    document.documentElement.setAttribute('data-glass-level', 'off');
    await flush();
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(setGlass).toHaveBeenLastCalledWith({ level: 'off', color: '#ffffff', symbolColor: '#c2bdc9' });
    expect(setAppearance).toHaveBeenLastCalledWith('system');
    stop();
  });

  it('sends a level once, not on every theme change', async () => {
    const stop = mount('soft', '#1A171D', 26200, true);
    document.documentElement.style.setProperty('--bg-base', '#171717');
    await flush();
    expect(setGlass).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('installWindowGlass on Windows without glass', () => {
  it.each([19045, 22000, null])('build %s: no glass, no appearance override, nothing sent', (build) => {
    const stop = mount('soft', '#1A171D', build, true);
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(setAppearance).not.toHaveBeenCalled();
    expect(setGlass).not.toHaveBeenCalled();
    stop();
  });
});
