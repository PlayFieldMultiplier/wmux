// The web clipboard shim keeps a copy the browser refused outside a user
// gesture (an OSC 52 write arrives over the network, after the click) and
// retries it inside the user's next tap or key.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PENDING_COPY_TTL_MS, webClipboardApi, type PendingCopyState } from '../webElectronApi';

type Api = {
  writeText: (text: string) => Promise<void>;
  onPendingCopy: (fn: (state: PendingCopyState) => void) => () => void;
};

function setup() {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  const doc = Object.assign(new EventTarget(), {
    body: null,
    activeElement: null,
    createElement: () => { throw new Error('unused: there is an async clipboard'); },
    execCommand: () => false,
  });
  const api = webClipboardApi({ clipboard: { writeText } as unknown as Clipboard }, doc as unknown as Document) as unknown as Api;
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

afterEach(() => { vi.useRealTimers(); });

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
});
