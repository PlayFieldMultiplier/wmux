// @vitest-environment jsdom
// A row description that overflows its one line gets an info button; the full
// text opens on click and Escape closes it without reaching Settings.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnedDialogContext, SettingRow } from '../SettingsLayout';
import { en } from '../../../i18n/locales/en';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG = 'First sentence of a long description. The rest only shows behind the info button.';
let root: Root;
let host: HTMLDivElement;
let overflow = true;

beforeEach(() => {
  // jsdom has no layout: report a clamped line as taller than its box.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return overflow && this.classList.contains('settings-clamp') ? 32 : 16;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(16);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

async function render(owned: (delta: number) => void) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <OwnedDialogContext.Provider value={owned}>
      <SettingRow label="Row" description={LONG}><input aria-label="control" /></SettingRow>
    </OwnedDialogContext.Provider>,
  ));
}

it('shows an info button only when the description overflows', async () => {
  overflow = false;
  await render(() => undefined);
  expect(host.querySelector('.settings-info')).toBeNull();
  expect(host.textContent).toContain(LONG);
  overflow = true;
});

it('opens the full text on click and closes it on Escape as an owned dialog', async () => {
  const owned = vi.fn();
  await render(owned);
  const button = host.querySelector<HTMLButtonElement>('.settings-info')!;
  expect(button.getAttribute('aria-label')).toBe(en['settings.moreInfo']);
  expect(button.getAttribute('aria-expanded')).toBe('false');

  await act(async () => button.click());
  const tip = document.getElementById(button.getAttribute('aria-controls')!)!;
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(tip.getAttribute('role')).toBe('tooltip');
  expect(tip.textContent).toBe(LONG);
  expect(owned).toHaveBeenLastCalledWith(1);

  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('.settings-info-tip')).toBeNull();
  expect(owned).toHaveBeenLastCalledWith(-1);
});

it('closes a pinned tip on a second click while the pointer is still over the button', async () => {
  await render(() => undefined);
  const button = host.querySelector<HTMLButtonElement>('.settings-info')!;

  await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(button.getAttribute('aria-expanded')).toBe('true');
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');

  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('.settings-info-tip')).toBeNull();
});
