import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Bind before launching the browser; consume exactly one state-matched callback. */
export async function createOAuthCallback(state: string, signal: AbortSignal, validateIssuer: (issuer: string | null) => boolean) {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation can precede the caller awaiting this promise during discovery.
  void code.catch(() => undefined);
  let consumed = false;
  let expectedHost = '';
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { res.writeHead(400); res.end('Invalid authorization callback.'); return; }
    const unique = ['state', 'code', 'error', 'iss'].every((k) => url.searchParams.getAll(k).length <= 1);
    if (req.method !== 'GET' || req.headers.host !== expectedHost || url.pathname !== '/oauth/callback'
      || consumed || !unique || url.searchParams.get('state') !== state || !validateIssuer(url.searchParams.get('iss'))) {
      res.writeHead(400); res.end('Invalid authorization callback.'); return;
    }
    const value = url.searchParams.get('code');
    if (url.searchParams.has('error') || !value || value.length > 8192) {
      consumed = true; res.writeHead(400); res.end('Authorization was not completed.'); reject(new Error('Authorization refused')); return;
    }
    consumed = true; res.end('Authorization received. Return to wmux to check the result.'); resolve(value);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  const close = () => { consumed = true; reject(new Error('Authorization cancelled')); server.closeAllConnections(); server.close(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (signal.aborted) throw new Error('Authorization cancelled');
    return { redirectUrl: `http://${expectedHost}/oauth/callback`, code, close: () => { signal.removeEventListener('abort', close); close(); } };
  } catch (error) { signal.removeEventListener('abort', close); close(); throw error; }
}
