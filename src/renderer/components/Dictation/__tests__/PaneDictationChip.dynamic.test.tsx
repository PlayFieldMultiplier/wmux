// @vitest-environment jsdom
//
// The pane being dictated into shows a corner chip (dot, elapsed time, Esc to
// cancel; a busy line while transcribing). Every other pane shows nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneDictationChip } from '../PaneDictationChip';
import { resetDictationMock, setDictation } from './dictationMock';

vi.mock('../../../dictation/dictation', () => import('./dictationMock'));
vi.mock('../../../hooks/useTerminal', () => ({ terminalRegistry: new Map() }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const chip = () => container.querySelector('[data-pane-dictation]');

beforeEach(() => {
  resetDictationMock();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PaneDictationChip ptyId="pty-1" />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PaneDictationChip', () => {
  it('shows on the pane being dictated into, and only there', () => {
    expect(chip()).toBeNull();
    act(() => setDictation({ phase: 'recording', target: 'pane:pty-2', startedAt: Date.now() }));
    expect(chip()).toBeNull();
    act(() => setDictation({ phase: 'recording', target: 'pane:pty-1', startedAt: Date.now() - 3_000 }));
    expect(chip()?.textContent).toBe('Dictating 0:03Esc to cancel');
    act(() => setDictation({ phase: 'transcribing', startedAt: null }));
    expect(chip()?.textContent).toBe('Transcribing…');
    act(() => setDictation({ phase: 'idle', target: null }));
    expect(chip()).toBeNull();
  });
});
