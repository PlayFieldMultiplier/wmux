// @vitest-environment jsdom
//
// #2398 (Codex review) — a leaf whose create was refused, and that another
// path then filled, must not bring the old refusal back when it empties again.
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../stores';
import { useClearRefusalWhenFilled } from '../ptyLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Leaf({ id, filled }: { id: string; filled: boolean }) {
  const refused = useStore((s) => s.ptyCreateByKey[id]?.state === 'createFailed');
  useClearRefusalWhenFilled(id, filled, refused);
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('useClearRefusalWhenFilled', () => {
  it('keeps the refusal while the leaf is empty, clears it once the leaf is filled', () => {
    act(() => useStore.getState().setPtyCreateAttempt('leaf-x', { state: 'createFailed', error: 'cap' }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Leaf, { id: 'leaf-x', filled: false })));
    expect(useStore.getState().ptyCreateByKey['leaf-x']?.state).toBe('createFailed');
    act(() => root?.render(createElement(Leaf, { id: 'leaf-x', filled: true })));
    expect(useStore.getState().ptyCreateByKey['leaf-x']).toBeUndefined();
  });
});
