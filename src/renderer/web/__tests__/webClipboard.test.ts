// @vitest-environment jsdom
// The web clipboard shim keeps a copy the browser refused outside a user
// gesture (an OSC 52 write arrives over the network, after the click) and
// retries it inside the user's next click, tap or key.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PENDING_COPY_TTL_MS, webClipboardApi, type PendingCopyState, type WebWriteOptions } from '../webElectronApi';
import { setPendingCopyHint } from '../pendingCopyHint';

type Api = {
  writeText: (text: string, opts?: WebWriteOptions) => Promise<void>;
  onPendingCopy: (fn: (state: PendingCopyState) => void) => () => void;
  finishPendingCopy: () => void;
};

function setup(userActivation?: { isActive: boolean }) {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const doc = Object.assign(new EventTarget(), {
    body: null,
    activeElement: null,
    createElement: () => { throw new Error('unused: there is an async clipboard'); },
    execCommand: () => false,
  });
  const api = webClipboardApi({ clipboard: { writeText } as unknown as Clipboard, userActivation }, doc as unknown as Document) as unknown as Api;
  const states: PendingCopyState[] = [];
  api.onPendingCopy((s) => states.push(s));
  const gesture = (type: string, pointerType?: string) => {
    const e = Object.assign(new Event(type), pointerType ? { pointerType } : {});
    doc.dispatchEvent(e);
    return e;
  };
  return { writeText, api, states, gesture };
}

const settled = (p: Promise<void>) => p.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
  delete (document as { execCommand?: unknown }).execCommand;
  document.body.replaceChildren();
});

describe('webClipboardApi pending copy', () => {
  it('keeps a refused copy, shows the hint, and lands it on the next tap', async () => {
    const { writeText, api, states, gesture } = setup();
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const result = settled(api.writeText('osc52 text'));
    await flush();
    expect(states).toEqual(['waiting']);

    // A touch press grants no activation; its release does.
    gesture('pointerdown', 'touch');
    expect(writeText).toHaveBeenCalledTimes(1);
    writeText.mockResolvedValueOnce(undefined);
    const e = gesture('pointerup', 'touch');
    expect(e.defaultPrevented).toBe(false);
    expect(writeText).toHaveBeenLastCalledWith('osc52 text');
    expect(await result).toBe('resolved');
    expect(states).toEqual(['waiting', 'copied']);

    // Cleared: a later key writes nothing.
    gesture('keydown');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('lets a newer copy replace the pending one, and drops a copy no gesture came for', async () => {
    vi.useFakeTimers();
    const { writeText, api, states, gesture } = setup();
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    const older = settled(api.writeText('older'));
    await vi.advanceTimersByTimeAsync(0);
    const newer = settled(api.writeText('newer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await older).toBe('rejected: copy replaced by a newer one');

    // Still refused inside the gesture: kept for the next one.
    gesture('keydown');
    expect(writeText).toHaveBeenLastCalledWith('newer');
    await vi.advanceTimersByTimeAsync(PENDING_COPY_TTL_MS);
    expect(await newer).toBe('rejected: copy expired before a gesture');
    expect(states).toEqual(['waiting', 'dropped', 'waiting', 'dropped']);

    const calls = writeText.mock.calls.length;
    gesture('pointerdown', 'mouse');
    expect(writeText).toHaveBeenCalledTimes(calls);
  });

  it('drops the pending copy when a newer one lands, so a later key cannot restore the older text', async () => {
    const { writeText, api, states, gesture } = setup();
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const older = settled(api.writeText('older'));
    await flush();
    writeText.mockResolvedValueOnce(undefined);
    await api.writeText('in-gesture copy');
    expect(await older).toBe('rejected: copy replaced by a newer one');
    expect(states).toEqual(['waiting', 'dropped']);
    gesture('keydown');
    expect(writeText).toHaveBeenCalledTimes(2);

    // Past the clipboard IPC's 1 MB cap a refused copy is not kept.
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    expect(await settled(api.writeText('x'.repeat(1_000_001)))).toBe('rejected: copy refused');
    expect(states).toEqual(['waiting', 'dropped']);
  });

  it('does not keep an older refusal that answers after a newer write', async () => {
    const { writeText, api, states, gesture } = setup();
    let refuseOlder: (err: Error) => void = () => undefined;
    writeText.mockImplementationOnce(() => new Promise<void>((_, reject) => { refuseOlder = reject; }));
    const older = settled(api.writeText('older'));
    writeText.mockResolvedValueOnce(undefined);
    await api.writeText('newer');
    refuseOlder(new Error('NotAllowedError'));
    expect(await older).toBe('rejected: copy refused');
    expect(states).toEqual([]);
    gesture('keydown');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('does not drop a copy whose retry is still out when the TTL passes', async () => {
    vi.useFakeTimers();
    const { writeText, api, states, gesture } = setup();
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const result = settled(api.writeText('slow'));
    await vi.advanceTimersByTimeAsync(0);
    let land: () => void = () => undefined;
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { land = resolve; }));
    gesture('keydown');
    await vi.advanceTimersByTimeAsync(PENDING_COPY_TTL_MS);
    expect(states).toEqual(['waiting']);
    land();
    expect(await result).toBe('resolved');
    expect(states).toEqual(['waiting', 'copied']);
  });

  it('keeps nothing for a silent auto-copy or a refusal inside a gesture', async () => {
    const quiet = setup();
    quiet.writeText.mockRejectedValue(new Error('NotAllowedError'));
    expect(await settled(quiet.api.writeText('selection', { keepIfRefused: false }))).toBe('rejected: copy refused');
    expect(quiet.states).toEqual([]);
    quiet.gesture('keydown');
    expect(quiet.writeText).toHaveBeenCalledTimes(1);

    const active = setup({ isActive: true });
    active.writeText.mockRejectedValue(new Error('NotAllowedError'));
    expect(await settled(active.api.writeText('denied'))).toBe('rejected: copy refused');
    expect(active.states).toEqual([]);
  });
});

describe('webClipboardApi in a document', () => {
  it('hands focus back after the legacy copy, without scrolling', () => {
    const term = document.createElement('textarea');
    document.body.appendChild(term);
    term.focus();
    const focus = vi.spyOn(term, 'focus');
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => true), configurable: true });
    const api = webClipboardApi({ clipboard: undefined as unknown as Clipboard }, document) as unknown as Api;
    void api.writeText('no async clipboard');
    expect(document.activeElement).toBe(term);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('finishes the copy from the pill click, and the click stops at the pill', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValueOnce(new Error('NotAllowedError'));
    const api = webClipboardApi({ clipboard: { writeText } as unknown as Clipboard }, document) as unknown as Api;
    api.onPendingCopy((state) => setPendingCopyHint(state === 'waiting', api.finishPendingCopy));
    const result = settled(api.writeText('osc52 text'));
    await flush();
    const pill = document.getElementById('wmux-pending-copy-toast') as HTMLButtonElement;
    expect(pill.tagName).toBe('BUTTON');
    expect(pill.textContent).toBe('Click to finish copying');
    await flush();
    const status = document.getElementById('wmux-pending-copy-status') as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('Click to finish copying');
    const below = vi.fn();
    document.body.addEventListener('click', below);
    writeText.mockResolvedValueOnce(undefined);
    pill.click();
    expect(writeText).toHaveBeenLastCalledWith('osc52 text');
    expect(below).not.toHaveBeenCalled();
    expect(await result).toBe('resolved');
    expect(pill.disabled).toBe(true);
    expect(status.textContent).toBe('');
    document.body.removeEventListener('click', below);
  });
});
