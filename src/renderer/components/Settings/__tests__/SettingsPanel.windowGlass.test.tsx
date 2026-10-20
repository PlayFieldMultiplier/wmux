// @vitest-environment jsdom
//
// The window glass row: on a Windows build without the acrylic material it
// reads Off, every level is disabled and the reason is shown, whatever level
// the store holds; on a supported build the saved level is selected and
// picking another reaches the store.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowGlassSetting } from '../SettingsPanel';
import type { WindowGlassLevel } from '../../../utils/windowGlass';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(supported: boolean, value: WindowGlassLevel, onChange = vi.fn()): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<WindowGlassSetting supported={supported} value={value} onChange={onChange} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function option(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button, [role="radio"]')]
    .find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label} option`);
  return found;
}

const isDisabled = (el: HTMLElement) =>
  el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
const isSelected = (el: HTMLElement) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'on' || el.getAttribute('data-state') === 'checked';

describe('WindowGlassSetting', () => {
  it('reads Off, disables every level and says why without the material', () => {
    const onChange = vi.fn();
    const container = render(false, 'soft', onChange);
    for (const label of ['Off', 'Soft', 'Clear']) expect(isDisabled(option(container, label)), label).toBe(true);
    expect(isSelected(option(container, 'Off'))).toBe(true);
    expect(isSelected(option(container, 'Soft'))).toBe(false);
    expect(container.textContent).toContain('Needs Windows 11 version 22H2 or later. This Windows keeps a solid window.');
    act(() => option(container, 'Clear').click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects the saved level and changes it where the material exists', () => {
    const onChange = vi.fn();
    const container = render(true, 'soft', onChange);
    for (const label of ['Off', 'Soft', 'Clear']) expect(isDisabled(option(container, label)), label).toBe(false);
    expect(isSelected(option(container, 'Soft'))).toBe(true);
    expect(container.textContent).not.toContain('Needs Windows 11');
    act(() => option(container, 'Clear').click());
    expect(onChange).toHaveBeenCalledWith('clear');
  });
});
