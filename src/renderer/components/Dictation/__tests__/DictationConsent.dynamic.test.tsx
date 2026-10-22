// @vitest-environment jsdom
//
// The speech model's consent shows only while dictation asks for it, says
// what is downloaded and what happens to the audio, and downloads nothing
// until Download. The host turns failures into toasts and Esc into a cancel.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { DictationHost } from '../DictationHost';
import {
  acceptModelDownload,
  cancelDictation,
  cancelModelDownload,
  clearDictationError,
  declineModelDownload,
  resetDictationMock,
  setDictation,
} from './dictationMock';

vi.mock('../../../dictation/dictation', () => import('./dictationMock'));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const q = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel);

beforeEach(() => {
  resetDictationMock();
  act(() => useStore.setState({ toasts: [] }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DictationHost />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState(useStore.getInitialState()));
});

describe('dictation consent', () => {
  it('shows only in consent, and Download calls acceptModelDownload', () => {
    expect(q('[data-testid="dictation-consent"]')).toBeNull();
    act(() => setDictation({ phase: 'recording', target: 'chat:p', startedAt: 1 }));
    expect(q('[data-testid="dictation-consent"]')).toBeNull();

    act(() => setDictation({ phase: 'consent', target: 'chat:p', startedAt: null }));
    const dialog = q('[data-testid="dictation-consent"]')!;
    const text = dialog.textContent ?? '';
    expect(text).toContain('About 80 MB');
    expect(text).toContain('huggingface.co · onnx-community/whisper-base');
    expect(text).toContain('Revision 1846881b6b3a');
    expect(text).toContain('MIT');
    expect(text).toContain("On this computer, in wmux's data folder");
    expect(text).toContain('never stored or sent');
    expect(acceptModelDownload).not.toHaveBeenCalled();

    act(() => q<HTMLButtonElement>('[data-testid="dictation-consent-download"]')!.click());
    expect(acceptModelDownload).toHaveBeenCalledTimes(1);
    act(() => q<HTMLButtonElement>('[data-testid="dictation-consent-decline"]')!.click());
    expect(declineModelDownload).toHaveBeenCalledTimes(1);
  });

  it('shows the download with Cancel, then says to press the mic again', () => {
    act(() => setDictation({ phase: 'downloading', model: { state: 'downloading', received: 40_000_000, total: 79_663_191 } }));
    expect(q('[data-testid="dictation-downloading"]')?.textContent).toContain('40 MB of 80 MB');
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    act(() => q<HTMLButtonElement>('[data-testid="dictation-download-cancel"]')!.click());
    expect(cancelModelDownload).toHaveBeenCalledTimes(1);

    act(() => setDictation({ phase: 'idle', target: null, model: { state: 'ready' } }));
    expect(q('[data-testid="dictation-downloading"]')).toBeNull();
    expect(q('[data-testid="dictation-ready"]')?.textContent).toContain('Click the microphone or press the shortcut again');
  });

  it('a cancelled download closes without the ready note', () => {
    act(() => setDictation({ phase: 'downloading', model: { state: 'downloading', received: 1, total: 2 } }));
    act(() => setDictation({ phase: 'idle', target: null, model: { state: 'absent' } }));
    expect(q('[data-testid="dictation-ready"]')).toBeNull();
  });
});

describe('dictation host', () => {
  it('says how to allow the microphone, then clears the error', () => {
    act(() => setDictation({ error: 'mic-denied' }));
    expect(useStore.getState().toasts.at(-1)?.message).toContain('Allow microphone access for wmux');
    expect(clearDictationError).toHaveBeenCalled();
  });

  it('gives any other failure a short toast', () => {
    act(() => setDictation({ error: 'the speech engine stopped' }));
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'error', message: 'Dictation failed: the speech engine stopped' });
  });

  it('Esc cancels a recording before anything else sees the key', () => {
    const later = vi.fn();
    document.addEventListener('keydown', later);
    act(() => setDictation({ phase: 'recording', target: 'pane:pty-1', startedAt: 1 }));
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(cancelDictation).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();

    act(() => setDictation({ phase: 'idle', target: null, startedAt: null }));
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(cancelDictation).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', later);
  });
});
