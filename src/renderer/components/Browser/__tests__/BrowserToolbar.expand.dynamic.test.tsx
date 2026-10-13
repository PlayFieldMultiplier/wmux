// @vitest-environment jsdom
//
// #2140 — the browser side of a terminal+browser split can fill the pane. The
// toolbar shows the toggle only when the split hands it one, and the button
// says which way it goes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserToolbar from '../BrowserToolbar';
import { useStore } from '../../../stores';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const noop = vi.fn();

function toolbar(extra: { expanded?: boolean; onToggleExpanded?: () => void }): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(BrowserToolbar, {
      currentUrl: 'https://example.com/',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true,
      inspecting: false,
      onNavigate: noop,
      onBack: noop,
      onForward: noop,
      onRefresh: noop,
      onToggleInspect: noop,
      onOpenDevTools: noop,
      onClose: noop,
      ...extra,
    }));
  });
}

const toggle = () => document.querySelector<HTMLButtonElement>('button[aria-pressed]');

beforeEach(() => {
  act(() => { useStore.setState({ locale: 'en' }); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BrowserToolbar expand toggle', () => {
  it('is absent outside a terminal+browser split', () => {
    toolbar({});
    expect(toggle()).toBeNull();
  });

  it('expands, then offers the terminal back', () => {
    const onToggleExpanded = vi.fn();
    toolbar({ expanded: false, onToggleExpanded });
    expect(toggle()?.getAttribute('aria-label')).toBe('Expand browser');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    act(() => { toggle()?.click(); });
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);

    act(() => { root.unmount(); });
    container.remove();
    toolbar({ expanded: true, onToggleExpanded });
    expect(toggle()?.getAttribute('aria-label')).toBe('Show terminal');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  });
});
