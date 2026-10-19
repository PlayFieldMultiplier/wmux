import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createCodexTuiRelay} from '../codexTuiRelay';

// A Windows test of the relay's upgrade checks. Only there does the relay
// listen on loopback TCP behind a per-launch bearer. The account server is
// stubbed: its socket identity and readiness probe, and the TUI's upstream
// link, which goes to a plain local WebSocket server (no refused upgrade
// reaches it).
const upstream = vi.hoisted(()=>({url:''}));
vi.mock('../codexAccountSocket',async(importOriginal)=>{
  const {default:Client} = await import('ws');
  return {
    ...await importOriginal<typeof import('../codexAccountSocket')>(),
    windowsCodexSocketIdentity:vi.fn(async()=>'1:1'),
    openCodexAccountSocket:vi.fn((_socketPath:string,options:ConstructorParameters<typeof Client>[2])=>new Client(upstream.url,options)),
  };
});
vi.mock('../codexSettingsTransport',async(importOriginal)=>({
  ...await importOriginal<typeof import('../codexSettingsTransport')>(),
  connectCodexSettings:vi.fn(async()=>({close:()=>{ /* noop */ }})),
}));

type Relay = Awaited<ReturnType<typeof createCodexTuiRelay>>;
/** The HTTP status an upgrade gets: 101 when it opens. */
function upgrade(relay:Relay, headers:Record<string,string>, origin?:string):Promise<number> {
  return new Promise(resolve=>{
    const socket = new WebSocket(`${relay.url}/rpc`,{headers,...(origin ? {origin} : {})});
    socket.once('open',()=>{socket.terminate();resolve(101);});
    socket.once('unexpected-response',(_req,res)=>{res.resume();socket.terminate();resolve(res.statusCode ?? 0);});
    socket.once('error',()=>resolve(0));
  });
}

describe.runIf(process.platform === 'win32')('Codex TUI relay upgrade checks on Windows',()=>{
  let home:string;
  let server:WebSocketServer;
  beforeEach(async()=>{
    home = await mkdtemp(path.join(os.tmpdir(),'wmux-relay-win-'));
    server = new WebSocketServer({host:'127.0.0.1',port:0});
    await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
    const address = server.address();
    upstream.url = typeof address === 'string' ? address : `ws://127.0.0.1:${address.port}`;
  });
  afterEach(async()=>{
    vi.useRealTimers();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(home,{recursive:true,force:true});
  });

  it('refuses a missing bearer, a wrong bearer and an Origin, then accepts the TUI\'s own bearer',async()=>{
    const relay = await createCodexTuiRelay({codeHome:home});
    try {
      expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(relay.authToken).toMatch(/^[a-f0-9]{64}$/);
      const bearer = {authorization:`Bearer ${relay.authToken}`};
      expect(await upgrade(relay,{})).toBe(403);
      expect(await upgrade(relay,{authorization:`Bearer ${'0'.repeat(64)}`})).toBe(403);
      expect(await upgrade(relay,bearer,'http://127.0.0.1')).toBe(403);
      // None of those claimed the relay: the bearer alone still opens it.
      expect(relay.retired()).toBe(false);
      expect(await upgrade(relay,bearer)).toBe(101);
    } finally {await relay.close();}
  });

  it('closes a relay no TUI claimed within its claim window',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const relay = await createCodexTuiRelay({codeHome:home});
    try {
      vi.advanceTimersByTime(29_999);
      expect(relay.retired()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(relay.retired()).toBe(true);
      vi.useRealTimers();
      expect(await upgrade(relay,{authorization:`Bearer ${relay.authToken}`})).not.toBe(101);
    } finally {await relay.close();}
  });
});
