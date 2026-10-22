// "Dictate into this pane": a built-in with a default key that collides with
// no other built-in, listed in Settings → Shortcuts and movable like the rest.
import { describe, expect, it } from 'vitest';
import {
  ADVERTISED_SHORTCUTS,
  defaultBindings,
  effectiveBindings,
  rebindProblem,
  resolveShortcut,
  sanitizeShortcutOverrides,
  type ShortcutKeyEventLike,
} from '../keymap';
import { QUICK_LAUNCH_DEFAULT_ACCELERATOR } from '../quickLaunch';

const key = (e: Partial<ShortcutKeyEventLike>): ShortcutKeyEventLike => ({
  key: 'S', code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...e,
});

describe('dictatePane shortcut', () => {
  it('is a listed, rebindable row', () => {
    const row = ADVERTISED_SHORTCUTS.find((e) => e.action === 'dictatePane');
    expect(row).toMatchObject({ combo: 'Ctrl+Shift+S', descriptionKey: 'settings.sc.dictatePane' });
  });

  it('defaults to ⌘⇧S on macOS and Ctrl+Shift+S elsewhere, owned by nothing else', () => {
    for (const [platform, combo] of [['darwin', 'Meta+Shift+S'], ['linux', 'Ctrl+Shift+S']] as const) {
      const bindings = defaultBindings(platform);
      expect(bindings.filter((b) => b.combo === combo)).toEqual([{ action: 'dictatePane', combo }]);
    }
    // Quick launch's global hotkey is the obvious other candidate; it is not this one.
    expect(QUICK_LAUNCH_DEFAULT_ACCELERATOR).not.toMatch(/\+S$/);
  });

  it('resolves on its default key and moves with an override', () => {
    const press = key({ ctrlKey: true, shiftKey: true });
    expect(resolveShortcut(press, defaultBindings('linux'))).toBe('dictatePane');
    expect(resolveShortcut(key({ metaKey: true, shiftKey: true }), defaultBindings('darwin'))).toBe('dictatePane');

    expect(rebindProblem('dictatePane', 'Ctrl+Alt+D', defaultBindings('linux'), 'linux', 'KeyB')).toBeNull();
    const overrides = sanitizeShortcutOverrides({ dictatePane: 'Ctrl+Alt+D' });
    expect(overrides).toEqual({ dictatePane: 'Ctrl+Alt+D' });
    const moved = effectiveBindings('linux', overrides);
    expect(resolveShortcut(press, moved)).toBeNull();
    expect(resolveShortcut(key({ key: 'd', code: 'KeyD', ctrlKey: true, altKey: true }), moved)).toBe('dictatePane');
    // Switched off, the key is nobody's.
    expect(resolveShortcut(press, effectiveBindings('linux', sanitizeShortcutOverrides({ dictatePane: null })))).toBeNull();
  });
});
