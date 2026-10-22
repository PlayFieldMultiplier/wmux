// @vitest-environment jsdom
//
// The Chat view composer's mic: one click starts, the next stops; the text
// lands in the box at the caret for the owner to edit, and is never sent.
// While recording the button reads pressed with a dot and the elapsed time;
// while transcribing it is a quiet busy state.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../ChatV2/Composer';
import { resetDictationMock, setDictation, toggleDictation } from './dictationMock';

vi.mock('../../../dictation/dictation', () => import('./dictationMock'));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onSend = vi.fn(async () => true);

function renderComposer() {
  act(() => root.render(
    <Composer
      paneId="pane-1"
      draftKey="pane-1:new"
      chips={{ model: 'sonnet', effort: '', mode: 'default', editable: true }}
      placeholder="Message"
      disabled={false}
      running={false}
      canStop={false}
      canAttach={false}
      onSend={onSend}
      onStop={() => undefined}
    />,
  ));
}
const q = <E extends HTMLElement = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const mic = () => q<HTMLButtonElement>('[data-dictation-button="chat:pane-1"]')!;
const box = () => q<HTMLTextAreaElement>('textarea')!;

beforeEach(() => {
  resetDictationMock();
  onSend.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { dictation: {} };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('Chat view composer mic', () => {
  it('toggles dictation and puts the text at the caret without sending', () => {
    renderComposer();
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box(), 'fix the  test');
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    box().setSelectionRange(8, 8);

    act(() => mic().click());
    expect(toggleDictation).toHaveBeenCalledWith('chat:pane-1', expect.any(Function));
    expect(mic().getAttribute('aria-label')).toBe('Dictate');

    act(() => setDictation({ phase: 'recording', target: 'chat:pane-1', startedAt: Date.now() - 5_000 }));
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-dictation-clock]')?.textContent).toBe('0:05');
    // The second click is the same toggle: it stops and transcribes.
    act(() => mic().click());
    expect(toggleDictation).toHaveBeenCalledTimes(2);

    act(() => setDictation({ phase: 'transcribing', startedAt: null }));
    expect(mic().disabled).toBe(true);
    expect(mic().getAttribute('aria-busy')).toBe('true');
    expect(q('[data-dictation-clock]')).toBeNull();

    const deliver = toggleDictation.mock.calls[0][1];
    act(() => {
      setDictation({ phase: 'idle', target: null });
      deliver('flaky');
    });
    expect(box().value).toBe('fix the flaky test');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('is unavailable while another input dictates', () => {
    renderComposer();
    act(() => setDictation({ phase: 'recording', target: 'pane:pty-1', startedAt: Date.now() }));
    expect(mic().disabled).toBe(true);
    expect(q('[data-dictation-clock]')).toBeNull();
  });
});
