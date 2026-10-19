import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { localReconnectAnswer } from '../localPtyReconnect';

/**
 * #2398 — the renderer keeps a pane's binding on a transient reconnect answer
 * and clears it (or hands it to the reconcile) only on `transient: false`. The
 * local handler answered an unknown id with no `transient` at all, so after a
 * daemon that never came back, a pane kept its dead daemon id for good.
 */
describe('localReconnectAnswer (#2398)', () => {
  it('attaches a pty this process owns', () => {
    expect(localReconnectAnswer({ id: 'p1', shell: 'pwsh.exe' }, false)).toEqual({ success: true, id: 'p1', shell: 'pwsh.exe' });
  });

  it('an unknown id is transient while a daemon may still come back', () => {
    expect(localReconnectAnswer(undefined, true)).toMatchObject({ success: false, code: 'daemon-reconnecting', transient: true });
  });

  it('an unknown id is gone for good once the local fallback is final', () => {
    expect(localReconnectAnswer(undefined, false)).toMatchObject({ success: false, code: 'session-dead', transient: false });
  });
});

describe('the local handler reads whether a daemon may come back (source lock)', () => {
  const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  it('the local pty:reconnect answers through localReconnectAnswer', () => {
    expect(read('src/main/ipc/handlers/pty.handler.ts')).toMatch(
      /localReconnectAnswer\(ptyManager\.get\(id\), opts\.daemonMayReturn\?\.\(\) \?\? false\)/,
    );
  });

  it('registerAllHandlers passes the predicate on, and main supplies it to every registration', () => {
    expect(read('src/main/ipc/registerHandlers.ts')).toMatch(
      /registerPTYHandlers\(ptyManager, ptyBridge, daemonClient, getWindow, \{ daemonMayReturn: options\.daemonMayReturn \}\)/,
    );
    const main = read('src/main/index.ts');
    const at = main.indexOf('const mcpHandlerOptions = {');
    expect(main.slice(at, at + 600)).toMatch(/daemonMayReturn: \(\): boolean => daemonRespawnController\?\.daemonMayReturn \?\? false/);
    // Every registration spreads (or passes) those options.
    const calls = main.split('registerAllHandlers(ptyManager, ptyBridge,').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 200)).toMatch(/mcpHandlerOptions/);
  });
});
