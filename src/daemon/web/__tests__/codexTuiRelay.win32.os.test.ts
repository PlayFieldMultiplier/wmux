import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import WebSocket,{WebSocketServer} from 'ws';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import net from 'node:net';
import {createCodexTuiRelay,type CodexRelayPolicy} from '../codexTuiRelay';
import {windowsCodexSocketIdentity} from '../codexAccountSocket';
import {deliberateSleep} from '../../../test-utils/waitFor';

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

/** An open connection carrying `headers`, the way a TUI holds one. */
function open(relay:Relay, headers:Record<string,string>):Promise<WebSocket> {
  return new Promise((resolve,reject)=>{
    const socket = new WebSocket(`${relay.url}/`,{headers});
    socket.once('open',()=>resolve(socket));
    socket.once('unexpected-response',(_req,res)=>{res.resume();socket.terminate();reject(new Error(`HTTP ${res.statusCode}`));});
    socket.once('error',reject);
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
    upstream.url = address && typeof address !== 'string' ? `ws://127.0.0.1:${address.port}` : '';
    vi.mocked(windowsCodexSocketIdentity).mockResolvedValue('1:1');
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

  // A Codex TUI opens a new app-server connection after its startup resume
  // picker closed the first one (#2612): the same launch must get back in.
  it('takes the same TUI\'s next connection once its previous one ended, one at a time',async()=>{
    const relay = await createCodexTuiRelay({codeHome:home});
    const bearer = {authorization:`Bearer ${relay.authToken}`};
    try {
      const first = await open(relay,bearer);
      // While a connection is live, nothing else gets in, the bearer included.
      expect(await upgrade(relay,bearer)).toBe(403);
      expect(await upgrade(relay,{authorization:`Bearer ${'0'.repeat(64)}`})).toBe(403);
      first.close();
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(true),{timeout:10_000});
      expect(relay.retired()).toBe(false);
      // Between connections a wrong bearer or an Origin is still refused.
      expect(await upgrade(relay,{authorization:`Bearer ${'0'.repeat(64)}`})).toBe(403);
      expect(await upgrade(relay,bearer,'http://127.0.0.1')).toBe(403);
      const second = await open(relay,bearer);
      // Live again once its server link opens.
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(false),{timeout:10_000});
      expect(await upgrade(relay,bearer)).toBe(403);
      second.close();
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(true),{timeout:10_000});
      await relay.close();
      expect(await upgrade(relay,bearer)).not.toBe(101);
    } finally {await relay.close();}
  });

  it('closes a relay whose TUI does not come back within the claim window',async()=>{
    let left:()=>void = ()=> { /* replaced below */ };
    const gone = new Promise<void>(resolve=>{left = resolve;});
    // Without vi.waitFor, which advances fake timers while it polls.
    const relay:Relay = await createCodexTuiRelay({codeHome:home,onStateChange:()=>{if (relay?.disconnected()) left();}});
    try {
      const first = await open(relay,{authorization:`Bearer ${relay.authToken}`});
      await vi.waitFor(()=>expect(relay.linked()).toBe(true),{timeout:10_000});
      vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
      first.close();
      await gone;
      vi.advanceTimersByTime(29_999);
      expect(relay.retired()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(relay.retired()).toBe(true);
    } finally {vi.useRealTimers();await relay.close();}
  });

  it('gives the claim back when the WebSocket layer aborts an authenticated upgrade',async()=>{
    const relay = await createCodexTuiRelay({codeHome:home});
    const bearer = {authorization:`Bearer ${relay.authToken}`};
    try {
      const port = Number(new URL(relay.url).port);
      const raw = net.connect(port,'127.0.0.1');
      const reply = new Promise<string>(resolve=>{let text='';raw.on('data',bytes=>{text += bytes.toString();});raw.once('close',()=>resolve(text));});
      // An unsupported WebSocket version: ws refuses the handshake itself.
      raw.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${relay.authToken}\r\nSec-WebSocket-Version: 99\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      expect(await reply).toMatch(/^HTTP\/1\.1 400 /);
      // Not stuck as claimed: the TUI's own connection still gets in.
      const tui = await vi.waitFor(()=>open(relay,bearer),{timeout:10_000});
      tui.close();
    } finally {await relay.close();}
  });

  it('a TUI leaving ends that connection\'s phone decisions and pinned references',async()=>{
    const owned = '22222222-89ab-4cde-8123-456789abcdef';
    const pending:string[] = [];
    const settled:{requestId:string;reason:string}[] = [];
    const policy:CodexRelayPolicy = {paneId:'pty-a',identity:()=>({}),serverProven:()=>true,
      owner:(threadId)=>threadId === owned ? {paneId:'pty-a',live:true} : undefined,recordOwner:()=>{ /* not exercised */ },
      decisionPending:(requestId)=>{pending.push(requestId);},
      decisionSettled:(requestId,_threadId,reason)=>{settled.push({requestId,reason});}};
    const linkLost = vi.fn();
    const relay = await createCodexTuiRelay({codeHome:home,policy,onLinkLost:linkLost});
    try {
      const tui = await open(relay,{authorization:`Bearer ${relay.authToken}`});
      await vi.waitFor(()=>expect(relay.linked()).toBe(true),{timeout:10_000});
      const delivered = new Promise<void>(resolve=>tui.once('message',()=>resolve()));
      for (const link of server.clients) link.send(JSON.stringify({method:'item/commandExecution/requestApproval',id:5,
        params:{threadId:owned,turnId:'turn-1',itemId:'call_5',availableDecisions:['accept','cancel'],command:'ls'}}));
      await delivered;
      expect(pending).toEqual(['5']);
      tui.close();
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(true),{timeout:10_000});
      expect(settled).toEqual([{requestId:'5',reason:'pane-gone'}]);
      // The owner moves this relay to a new incarnation: nothing pinned to the old connection matches.
      expect(linkLost).toHaveBeenCalledOnce();
      expect(relay.retired()).toBe(false);
    } finally {await relay.close();}
  });

  it('a TUI dropped by a closing relay is not waited for',async()=>{
    let changes = 0;
    const linkLost = vi.fn();
    const relay = await createCodexTuiRelay({codeHome:home,onStateChange:()=>{changes++;},onLinkLost:linkLost});
    try {
      const tui = await open(relay,{authorization:`Bearer ${relay.authToken}`});
      await vi.waitFor(()=>expect(relay.linked()).toBe(true),{timeout:10_000});
      const gone = new Promise<void>(resolve=>tui.once('close',()=>resolve()));
      await relay.close();
      const announced = changes;
      await gone;
      await deliberateSleep(100, 'a negative check: nothing else arrives after the TUI closed');
      // close() announced the retirement once; the TUI's close afterwards adds nothing.
      expect(changes).toBe(announced);
      expect(linkLost).not.toHaveBeenCalled();
      expect(relay.disconnected()).toBe(false);
    } finally {await relay.close();}
  });

  it('a TUI coming back on another account socket ends the old server\'s turns',async()=>{
    const serverLost = vi.fn();
    const relay = await createCodexTuiRelay({codeHome:home,onServerLost:serverLost});
    const bearer = {authorization:`Bearer ${relay.authToken}`};
    const cycle = async()=>{
      const tui = await open(relay,bearer);
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(false),{timeout:10_000});
      tui.close();
      await vi.waitFor(()=>expect(relay.disconnected()).toBe(true),{timeout:10_000});
    };
    try {
      await cycle();
      // Back on the same socket: the server lived on.
      await cycle();
      expect(serverLost).not.toHaveBeenCalled();
      // A restarted server binds a new socket.
      vi.mocked(windowsCodexSocketIdentity).mockResolvedValue('2:2');
      await cycle();
      expect(serverLost).toHaveBeenCalledOnce();
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
