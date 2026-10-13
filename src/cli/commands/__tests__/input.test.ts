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
    expect(rpc).toHaveBeenCalledWith('input.send', { text: 'hello there', ptyId: 'pty-other', submit: true });
    expect(selfContext).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it('takes a ptyId through --to or --pane unchanged', async () => {
    await handleInput('send', ['x', '--pane', 'daemon-9e8b7d2b'], false);
    expect(rpc).toHaveBeenCalledWith('input.send', { text: 'x', ptyId: 'daemon-9e8b7d2b' });
    expect(rpc).not.toHaveBeenCalledWith('pane.resolveName', expect.anything());
    expect(stripInputFlags(['a', '--to', '#w1-1', 'b', '--pane', 'p', '--submit'])).toEqual(['a', 'b']);
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
      { text: 'note for the other agent', ptyId: 'pty-self', workspaceId: 'ws-self', submit: true });
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

  it('reads the agent of a pane from a pane.list result', () => {
    expect(agentInPane(paneList('pty-a'), 'pty-a')).toEqual({ paneTag: '#w1-2', agentName: 'Codex CLI' });
    expect(agentInPane(paneList('pty-a'), 'pty-b')).toBeUndefined();
    expect(agentInPane({ error: 'booting' }, 'pty-a')).toBeUndefined();
  });
});
