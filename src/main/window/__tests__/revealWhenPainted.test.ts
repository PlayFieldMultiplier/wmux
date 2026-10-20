import { describe, expect, it, vi } from 'vitest';
import { revealWhenPainted } from '../revealWhenPainted';

function fakeWindow() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const add = (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); };
  const state = { visible: false, destroyed: false };
  const win = {
    once: vi.fn(add),
    show: vi.fn(() => { state.visible = true; }),
    // Electron's maximize() shows a hidden window.
    maximize: vi.fn(() => { state.visible = true; }),
    focus: vi.fn(),
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed,
    webContents: { on: vi.fn(add), once: vi.fn(add) },
  };
  const fire = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args);
  return { win, state, fire };
}

type Win = Parameters<typeof revealWhenPainted>[0];

describe('revealWhenPainted', () => {
  it('stays hidden until the first paint, then shows once', () => {
    const { win, fire } = fakeWindow();
    revealWhenPainted(win as unknown as Win, { maximize: false });
    expect(win.show).not.toHaveBeenCalled();
    fire('ready-to-show');
    fire('render-process-gone');
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.maximize).not.toHaveBeenCalled();
  });

  it('maximizes and focuses a restored maximized window instead of showing it', () => {
    const { win, fire } = fakeWindow();
    revealWhenPainted(win as unknown as Win, { maximize: true });
    fire('ready-to-show');
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
  });

  it('shows the window when the page fails to load, so the app is never left windowless', () => {
    const { win, fire } = fakeWindow();
    revealWhenPainted(win as unknown as Win, { maximize: false });
    fire('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///index.html', true);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('ignores a subframe that fails to load', () => {
    const { win, fire } = fakeWindow();
    revealWhenPainted(win as unknown as Win, { maximize: false });
    fire('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'https://example.invalid/', false);
    expect(win.show).not.toHaveBeenCalled();
  });

  it('shows the window when the renderer dies before it paints', () => {
    const { win, fire } = fakeWindow();
    revealWhenPainted(win as unknown as Win, { maximize: false });
    fire('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('does not show a window that is already visible, or destroyed', () => {
    const visible = fakeWindow();
    revealWhenPainted(visible.win as unknown as Win, { maximize: false });
    visible.state.visible = true;
    visible.fire('ready-to-show');
    expect(visible.win.show).not.toHaveBeenCalled();

    const gone = fakeWindow();
    revealWhenPainted(gone.win as unknown as Win, { maximize: true });
    gone.state.destroyed = true;
    gone.fire('ready-to-show');
    expect(gone.win.maximize).not.toHaveBeenCalled();
  });
});
