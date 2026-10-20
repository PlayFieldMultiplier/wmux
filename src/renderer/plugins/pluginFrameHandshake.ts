/**
 * Accept a document-created port only after main confirms its bootstrap.
 * No privileged port is ever transferred to an iframe's moving WindowProxy.
 */
export function pluginFrameHandshake(iframe: HTMLIFrameElement, pluginName: string, frameName: string) {
  type Attempt = {
    nonce: string;
    confirmed: boolean;
    port: MessagePort | null;
    resolve: (port: MessagePort | null) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  let pending: Attempt | null = null;
  const finish = (port: MessagePort | null) => {
    const attempt = pending;
    if (!attempt) return;
    pending = null;
    clearTimeout(attempt.timer);
    if (attempt.port !== port) attempt.port?.close();
    attempt.resolve(port);
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.data?.kind !== 'wmux-plugin-bridge') return;
    const [port, ...extra] = event.ports;
    for (const item of extra) item.close();
    if (!port) return;
    if (!pending || event.data.nonce !== pending.nonce || pending.port) { port.close(); return; }
    pending.port = port;
    if (pending.confirmed) finish(port);
  };
  window.addEventListener('message', receive);
  return {
    request: () => {
      finish(null);
      return new Promise<MessagePort | null>((resolve) => {
        const attempt: Attempt = {
          nonce: crypto.randomUUID(), confirmed: false, port: null, resolve,
          timer: setTimeout(() => { if (pending === attempt) finish(null); }, 5000),
        };
        pending = attempt;
        window.electronAPI.plugins.frameReady(pluginName, frameName, attempt.nonce).then((ready) => {
          if (pending !== attempt) return;
          if (!ready) { finish(null); return; }
          attempt.confirmed = true;
          if (attempt.port) finish(attempt.port);
        }, () => { if (pending === attempt) finish(null); });
      });
    },
    cancel: () => finish(null),
    dispose: () => { finish(null); window.removeEventListener('message', receive); },
  };
}
