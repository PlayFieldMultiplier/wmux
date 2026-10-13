// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoomControls } from '../PreviewChrome';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('preview zoom field (#2150)', () => {
  it('applies a typed percentage on Enter, and Escape throws it away', () => {
    const onZoom = vi.fn();
    act(() => root.render(createElement(ZoomControls, { zoom: 1, fitted: true, onZoom, onFit: vi.fn() })));
    const field = container.querySelector('[data-preview-zoom-field]') as HTMLInputElement;

    act(() => field.focus());
    type(field, '500');
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onZoom).not.toHaveBeenCalled();
    expect(field.value).toBe('100%');

    act(() => field.focus());
    type(field, '150');
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onZoom).toHaveBeenCalledWith(1.5);
  });

  it('right-click on the field resets to 100%', () => {
    const onZoom = vi.fn();
    act(() => root.render(createElement(ZoomControls, { zoom: 0.4, fitted: false, onZoom, onFit: vi.fn() })));
    const field = container.querySelector('[data-preview-zoom-field]') as HTMLInputElement;
    act(() => { field.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    expect(onZoom).toHaveBeenCalledWith(1);
  });
});
