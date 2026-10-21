/**
 * `wmux send` / `send-key` targets.
 *
 * An agent that runs `wmux send '<text>'` from its own shell tool, with no
 * target, types into its OWN input (the CLI resolves the pane it runs in). What
 * these tests pin:
 *  1. `--to #name` resolves through pane.resolveName to that pane's ptyId, and
 *     `--to` / `--pane` never leak into the typed text,
 *  2. an unknown `#name` exits 1 before anything is typed,
 *  3. a send that resolved to the caller's own pane while an agent runs there
 *     still goes through, with a warning naming the pane and the agent,
 *  4. an explicit target, or a pane with no agent, prints no warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { agentInPane, handleInput, stripInputFlags } from '../input';
import { TERMINAL_START_BUDGET_MS, terminalWriteClientTimeoutMs } from '../../../shared/terminalWriteBudget';

// #2398 — every write carries its deadline to main and waits as long.
const deadline = terminalWriteClientTimeoutMs();

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

const paneList = (agentPty: string | null) => ({
  panes: [
    { paneTag: '#w1-1', agents: [] },
    { paneTag: '#w1-2', agents: agentPty ? [{ ptyId: agentPty, agentName: 'Codex CLI', agentStatus: 'running' }] : [] },
  ],
});

let errSpy: ReturnType<typeof vi.spyOn>;
let agentPty: string | null = 'pty-self';

beforeEach(() => {
  vi.clearAllMocks();
  agentPty = 'pty-self';
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self' });
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'pane.resolveName') {
      if (params.name === '#w1-3') return { ok: true, result: { ok: true, target: { surfaceId: 'surf-blank', paneTag: '#w1-3' } } };
      return params.name === '#w1-1'
        ? { ok: true, result: { ok: true, target: { ptyId: 'pty-other', paneTag: '#w1-1' } } }
        : { ok: true, result: { ok: false, reason: 'not_found', error: `no pane named "${String(params.name)}"` } };
    }
    if (method === 'pane.list') return { ok: true, result: paneList(agentPty) };
    return { ok: true, result: { ok: true } };
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warnings = (): string[] =>
  errSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.startsWith('Warning:'));

describe('wmux send targets', () => {
  it('resolves --to #name to that pane and keeps the flag out of the text', async () => {
    await handleInput('send', ['hello', 'there', '--to', '#w1-1', '--submit'], false);
    expect(rpc).toHaveBeenCalledWith('pane.resolveName', { name: '#w1-1' });
    expect(rpc).toHaveBeenCalledWith('input.send',
      { text: 'hello there', ptyId: 'pty-other', submit: true, clientTimeoutMs: deadline }, deadline);
    expect(selfContext).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it('takes a ptyId through --to or --pane unchanged', async () => {
    await handleInput('send', ['x', '--pane', 'daemon-9e8b7d2b'], false);
    expect(rpc).toHaveBeenCalledWith('input.send', { text: 'x', ptyId: 'daemon-9e8b7d2b', clientTimeoutMs: deadline }, deadline);
    expect(rpc).not.toHaveBeenCalledWith('pane.resolveName', expect.anything());
    expect(stripInputFlags(['a', '--to', '#w1-1', 'b', '--pane', 'p', '--submit'])).toEqual(['a', 'b']);
  });

  it('exits before typing anything when --to lost its value', async () => {
    // `wmux send "x" --to #w1-2` unquoted: the shell drops `#w1-2` as a comment.
    await expect(handleInput('send', ['x', '--submit', '--to'], false)).rejects.toThrow(ExitCalled);
    await expect(handleInput('send-key', ['enter', '--pane', '--submit'], false)).rejects.toThrow(ExitCalled);
    expect(rpc).not.toHaveBeenCalledWith('input.send', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('input.sendKey', expect.anything());
    expect(selfContext).not.toHaveBeenCalled();
  });

  // Second-model P3-3: a #name for a blank pane whose terminal has not
  // started has no ptyId, and `wmux send` failed with "has no local
  // terminal" where terminal_send starts it. It goes by its surface, with the
  // caller's workspace main checks it against; a read never starts it.
  it('sends to a #name whose terminal has not started by its surface, from inside a wmux pane', async () => {
    await handleInput('send', ['x', '--to', '#w1-3'], false);
    expect(rpc).toHaveBeenCalledWith('input.send',
      { text: 'x', surfaceId: 'surf-blank', workspaceId: 'ws-self', senderPtyId: 'pty-self', clientTimeoutMs: deadline }, deadline);
    await handleInput('send-key', ['enter', '--to', '#w1-3'], false);
    expect(rpc).toHaveBeenCalledWith('input.sendKey',
      { key: 'enter', surfaceId: 'surf-blank', workspaceId: 'ws-self', senderPtyId: 'pty-self', clientTimeoutMs: deadline }, deadline);
    await expect(handleInput('read-screen', ['--to', '#w1-3'], false)).rejects.toThrow(ExitCalled);
    expect(errSpy).toHaveBeenCalledWith('Error: pane #w1-3 has no local terminal');
  });

  it('outside a wmux pane, says why a #name whose terminal has not started cannot be started', async () => {
    selfContext.mockResolvedValue({});
    await expect(handleInput('send', ['x', '--to', '#w1-3'], false)).rejects.toThrow(ExitCalled);
    expect(rpc).not.toHaveBeenCalledWith('input.send', expect.anything(), expect.anything());
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/pane #w1-3 has not started its terminal yet/);
  });

  // Review P3: right after an update the CLI shim can run the new CLI against
  // the old main, which ignores surfaceId and writes the omitted target, the
  // active pane (often the caller's own). senderPtyId makes that main refuse;
  // without the caller's own ptyId nothing is sent.
  it("a surface target carries the caller's senderPtyId, and is refused without one", async () => {
    selfContext.mockResolvedValue({ workspaceId: 'ws-self' });
    await expect(handleInput('send-key', ['enter', '--to', '#w1-3'], false)).rejects.toThrow(ExitCalled);
    expect(rpc).not.toHaveBeenCalledWith('input.sendKey', expect.anything(), expect.anything());
  });

  it('exits before typing anything when a #name does not resolve', async () => {
    await expect(handleInput('send', ['x', '--to', '#nope'], false)).rejects.toThrow(ExitCalled);
    expect(rpc).not.toHaveBeenCalledWith('input.send', expect.anything());
    expect(errSpy).toHaveBeenCalledWith('Error: no pane named "#nope"');
  });

  it('warns when no target sent the text into the caller\'s own agent pane', async () => {
    agentPty = 'pty-self';
    await handleInput('send', ['note for the other agent', '--submit'], false);
    expect(rpc).toHaveBeenCalledWith('input.send',
      { text: 'note for the other agent', ptyId: 'pty-self', workspaceId: 'ws-self', submit: true, clientTimeoutMs: deadline },
      deadline);
    expect(rpc).toHaveBeenCalledWith('pane.list', { workspaceId: 'ws-self' });
    const [warning] = warnings();
    expect(warning).toMatch(/your own pane #w1-2, where Codex CLI is running/);
    expect(warning).toMatch(/--to <#pane\|ptyId>/);
  });

  it('warns the same way for send-key, and stays quiet in a pane with no agent', async () => {
    await handleInput('send-key', ['ctrl-c'], false);
    expect(warnings()).toHaveLength(1);
    errSpy.mockClear();
    agentPty = 'pty-somewhere-else';
    await handleInput('send', ['echo hi', '--submit'], false);
    expect(warnings()).toEqual([]);
  });

  // Review item 3 — the CLI's generic 15 s deadline was shorter than the
  // start a write may now wait on (a WSL pane's first start), so `wmux send`
  // gave up, exited non-zero, and main still wrote: a retry typed it twice.
  it('waits for a pane start and tells main its deadline, for send and send-key', async () => {
    expect(deadline).toBeGreaterThan(TERMINAL_START_BUDGET_MS);
    await handleInput('send', ['x', '--to', '#w1-1'], false);
    await handleInput('send-key', ['enter', '--to', '#w1-1'], false);
    const writes = rpc.mock.calls.filter((c: unknown[]) => c[0] === 'input.send' || c[0] === 'input.sendKey');
    expect(writes).toHaveLength(2);
    for (const [, params, timeoutMs] of writes) {
      expect(timeoutMs).toBe(deadline);
      expect((params as Record<string, unknown>).clientTimeoutMs).toBe(deadline);
    }
  });

  it('reads the agent of a pane from a pane.list result', () => {
    expect(agentInPane(paneList('pty-a'), 'pty-a')).toEqual({ paneTag: '#w1-2', agentName: 'Codex CLI' });
    expect(agentInPane(paneList('pty-a'), 'pty-b')).toBeUndefined();
    expect(agentInPane({ error: 'booting' }, 'pty-a')).toBeUndefined();
  });
});
