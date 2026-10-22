import net from 'node:net';
import {Writable} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

// wmux.cmd's private `codex` steps (#2612). The pane claim, the relay RPCs
// and the managed Codex binary are stubbed; nothing here reaches a daemon.
const rpc = vi.hoisted(()=>({calls:[] as {method:string;params:unknown}[]}));
vi.mock('../../client',()=>({
  setWorkspaceToken:vi.fn(),
  sendRequest:vi.fn(async(method:string,params:unknown)=>{
    rpc.calls.push({method,params});
    if (method === 'codex.relay.prepare') {
      return {ok:true,result:{url:'ws://127.0.0.1:4567',authToken:'a'.repeat(64),leaseId:'11111111-2222-3333-4444-555555555555'}};
    }
    return {ok:true,result:{ok:true}};
  }),
}));
vi.mock('../../identity',()=>({
  getParentPidDefault:vi.fn(),
  resolveSelfContext:vi.fn(async()=>({ptyId:'pty-1',workspaceToken:'ws-token'})),
}));
vi.mock('../../../shared/codexManagedExecutable',()=>({
  resolveCodexManagedExecutable:vi.fn(()=>'C:\\Users\\u\\.codex\\packages\\app-server-daemon\\current\\bin\\codex.exe'),
}));

import {codexHandoff,codexRelease,handleCodex} from '../codex';
import {sendRequest} from '../../client';
import {resolveSelfContext} from '../../identity';
import {resolveCodexManagedExecutable} from '../../../shared/codexManagedExecutable';

/** What wmux.cmd's `for /f` reads: a pipe, as a net.Socket. */
function pipe():{stream:NodeJS.WriteStream; text:()=>string} {
  let text = '';
  const stream = new net.Socket() as unknown as NodeJS.WriteStream;
  (stream as unknown as {write:(chunk:string,cb:(e?:Error)=>void)=>boolean}).write = (chunk,cb)=>{text += chunk;cb();return true;};
  return {stream,text:()=>text};
}

describe('wmux codex through wmux.cmd',()=>{
  const platform = process.platform;
  beforeEach(()=>{
    rpc.calls.length = 0;
    Object.defineProperty(process,'platform',{value:'win32'});
    vi.spyOn(process,'cwd').mockReturnValue('D:\\');
    // wmux.cmd always settles CODEX_HOME before the handoff.
    vi.stubEnv('CODEX_HOME','C:\\Users\\u\\.codex');
  });
  afterEach(()=>{
    Object.defineProperty(process,'platform',{value:platform});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('hands the launch to the script\'s pipe, with the bearer in `codex` and the lease last',async()=>{
    const out = pipe();
    await codexHandoff('codex resume "a b"',out.stream);
    const lines = out.text().trimEnd().split('\n');
    expect(lines).toEqual([
      'WMUX_CODEX_EXE=packages\\app-server-daemon\\current\\bin\\codex.exe',
      'WMUX_CODEX_LAUNCH=--remote ws://127.0.0.1:4567',
      'WMUX_CODEX_CD=1',
      `codex=${'a'.repeat(64)}`,
      'WMUX_CODEX_LEASE=11111111-2222-3333-4444-555555555555',
    ]);
    expect(rpc.calls.map(c=>c.method)).toEqual(['codex.relay.prepare']);
  });

  it('leaves the directory to the user\'s own -C',async()=>{
    const out = pipe();
    await codexHandoff('codex -C "D:\\work dir"',out.stream);
    expect(out.text()).toContain('WMUX_CODEX_LAUNCH=--remote ws://127.0.0.1:4567\n');
    expect(out.text()).not.toContain('WMUX_CODEX_CD');
  });

  // cmd's for /f reads this pipe in the console's code page (949 on Korean Windows).
  it('hands no path over the pipe: a Korean user name stays with the script',async()=>{
    vi.stubEnv('CODEX_HOME','C:\\Users\\홍길동\\.codex');
    vi.mocked(process.cwd).mockReturnValue('D:\\작업 폴더');
    vi.mocked(resolveCodexManagedExecutable).mockReturnValueOnce('C:\\Users\\홍길동\\.codex\\packages\\app-server-daemon\\releases\\0.163.0-x86_64-pc-windows-msvc\\bin\\codex.exe');
    const out = pipe();
    await codexHandoff('codex',out.stream);
    expect(out.text()).toMatch(/^[\x20-\x7e\n]*$/);
    expect(out.text().split('\n').slice(0,3)).toEqual([
      'WMUX_CODEX_EXE=packages\\app-server-daemon\\releases\\0.163.0-x86_64-pc-windows-msvc\\bin\\codex.exe',
      'WMUX_CODEX_LAUNCH=--remote ws://127.0.0.1:4567',
      'WMUX_CODEX_CD=1',
    ]);
    expect(rpc.calls[0]).toEqual({method:'codex.relay.prepare',params:{codeHome:'C:\\Users\\홍길동\\.codex'}});
  });

  it('names the binary through the install link when the install lives outside CODEX_HOME',async()=>{
    vi.mocked(resolveCodexManagedExecutable).mockReturnValueOnce('E:\\codex-packages\\app-server-daemon\\releases\\1\\bin\\codex.exe');
    const out = pipe();
    await codexHandoff('codex',out.stream);
    expect(out.text().split('\n')[0]).toBe('WMUX_CODEX_EXE=packages\\app-server-daemon\\current\\bin\\codex.exe');
  });

  it('reserves nothing without the CODEX_HOME the script settles',async()=>{
    vi.stubEnv('CODEX_HOME','');
    await expect(codexHandoff('codex',pipe().stream)).rejects.toThrow(/CODEX_HOME/);
    expect(rpc.calls).toEqual([]);
  });

  it('never prints the bearer to a console or a file',async()=>{
    const console = Object.assign(new net.Socket(),{isTTY:true}) as unknown as NodeJS.WriteStream;
    await expect(codexHandoff('codex',console)).rejects.toThrow(/wmux codex/);
    const file = new Writable({write:(_c,_e,cb)=>cb()}) as unknown as NodeJS.WriteStream;
    await expect(codexHandoff('codex',file)).rejects.toThrow(/wmux codex/);
    expect(rpc.calls).toEqual([]);
  });

  it('refuses options that replace the pane connection before reserving anything',async()=>{
    await expect(codexHandoff('codex --no-daemon',pipe().stream)).rejects.toThrow(/owns its pane connection/);
    await expect(codexHandoff('codex --remote ws://x',pipe().stream)).rejects.toThrow(/owns its pane connection/);
    await expect(codexHandoff(undefined,pipe().stream)).rejects.toThrow();
    expect(rpc.calls).toEqual([]);
  });

  it('releases the lease it is given, and only a lease id',async()=>{
    await codexRelease('11111111-2222-3333-4444-555555555555');
    expect(rpc.calls).toEqual([{method:'codex.relay.close',params:{leaseId:'11111111-2222-3333-4444-555555555555'}}]);
    await expect(codexRelease('../x')).rejects.toThrow();
    expect(rpc.calls).toHaveLength(1);
  });

  it('says so when it cannot release the lease',async()=>{
    const stderr = vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
    vi.mocked(resolveSelfContext).mockResolvedValueOnce({ptyId:'pty-1'} as Awaited<ReturnType<typeof resolveSelfContext>>);
    await codexRelease('11111111-2222-3333-4444-555555555555');
    expect(rpc.calls).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/could not close this pane's Codex link/));
    stderr.mockClear();
    vi.mocked(sendRequest).mockResolvedValueOnce({ok:false,error:'down'} as Awaited<ReturnType<typeof sendRequest>>);
    await codexRelease('11111111-2222-3333-4444-555555555555');
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/could not close/));
    stderr.mockClear();
    await codexRelease('11111111-2222-3333-4444-555555555555');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('refuses to start Codex from a host with no console, before reserving a lease',async()=>{
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin,'isTTY',{value:undefined,configurable:true});
    try {
      await expect(handleCodex([])).rejects.toThrow(/console/);
      expect(rpc.calls).toEqual([]);
    } finally {Object.defineProperty(process.stdin,'isTTY',{value:isTTY,configurable:true});}
  });
});
