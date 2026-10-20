// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { pluginFrameHandshake } from '../pluginFrameHandshake';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  let confirm!: (ready: boolean) => void;
  const frameReady = vi.fn((_plugin: string, _frame: string, _nonce: string) => new Promise<boolean>((resolve) => { confirm = resolve; }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { plugins: { frameReady } } });
  const handshake = pluginFrameHandshake(iframe, 'demo', 'frame');
  const offer = (nonce = frameReady.mock.calls.at(-1)?.[2]) => {
    const channel = new MessageChannel();
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow, data: { kind: 'wmux-plugin-bridge', nonce }, ports: [channel.port1],
    }));
    return channel;
  };
  return { iframe, frameReady, handshake, offer, get confirm() { return confirm; },
    dispose: () => { handshake.dispose(); iframe.remove(); } };
}

it('keeps a pre-confirmation offer bound to its original document when WindowProxy changes', async () => {
  const test = setup();
  const pending = test.handshake.request();
  const channel = test.offer();
  const replacement = { postMessage: vi.fn() };
  Object.defineProperty(test.iframe, 'contentWindow', { value: replacement });
  test.confirm(true);
  expect(await pending).toBe(channel.port1);
  expect(replacement.postMessage).not.toHaveBeenCalled();
  channel.port1.close(); channel.port2.close(); test.dispose();
});

it('rejects an old document offer after a new attempt and never grants it on a late confirmation', async () => {
  const test = setup();
  const first = test.handshake.request();
  const oldNonce = test.frameReady.mock.calls[0][2];
  const confirmOld = test.confirm;
  const second = test.handshake.request();
  expect(await first).toBeNull();
  confirmOld(true);
  const old = test.offer(oldNonce);
  const current = test.offer();
  test.confirm(true);
  expect(await second).toBe(current.port1);
  old.port2.close(); current.port1.close(); current.port2.close(); test.dispose();
});

it('times out when confirmation arrives without a document offer', async () => {
  vi.useFakeTimers();
  const test = setup();
  const pending = test.handshake.request();
  test.confirm(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBeNull();
  test.dispose();
});
