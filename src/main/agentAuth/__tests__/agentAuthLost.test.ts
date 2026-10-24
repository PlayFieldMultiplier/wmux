import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../../notification/dispatchNotification', () => ({ dispatchNotification: vi.fn() }));

import { AuthLostBoard, answerLoginState } from '../agentAuthLost';
import { authLostKey, parseAgentAuthLost, type AgentAuthLost } from '../../../shared/agentAuthLost';

const lost = (over: Partial<AgentAuthLost> = {}): AgentAuthLost => ({ agent: 'claude', configDir: null, origin: 'turn', at: 1, ...over });

describe('AuthLostBoard', () => {
  it('opens one entry per agent and account however many panes report it', () => {
    const board = new AuthLostBoard();
    expect(board.report('pty-1', lost())).toBe(true);
    expect(board.report('pty-2', lost({ origin: 'start' }))).toBe(false);
    expect(board.report('pty-3', lost({ configDir: '/acc/work' }))).toBe(true);
    expect(board.report('pty-4', lost({ agent: 'codex' }))).toBe(true);
    expect(board.list().find((e) => e.key === authLostKey('claude', null))?.ptyIds).toEqual(['pty-1', 'pty-2']);
  });

  it('drops the entry when one of its panes works again, but not when a pane just closes', () => {
    const board = new AuthLostBoard();
    board.report('pty-1', lost());
    board.report('pty-2', lost());
    expect(board.forgetPane('pty-1')).toBe(true);
    expect(board.list()).toHaveLength(1);
    expect(board.paneWorks('pty-9')).toBe(false);
    expect(board.paneWorks('pty-2')).toBe(true);
    expect(board.list()).toEqual([]);
    // Signed out again later: a new entry, so a new notice.
    expect(board.report('pty-2', lost())).toBe(true);
  });
});

describe('answerLoginState', () => {
  it('clears the entry once the agent says signed in, and never probes a key the daemon did not report', async () => {
    const board = new AuthLostBoard();
    board.report('', lost({ origin: 'schedule', configDir: '/acc/work' }));
    const key = authLostKey('claude', '/acc/work');
    const probe = vi.fn(async () => false as boolean | null);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: true, signedIn: false, cleared: false });
    expect(board.list()).toHaveLength(1);
    probe.mockResolvedValueOnce(true);
    expect(await answerLoginState(board, key, probe)).toEqual({ known: true, signedIn: true, cleared: true });
    expect(board.list()).toEqual([]);
    expect(await answerLoginState(board, 'claude:/etc', probe)).toEqual({ known: false });
    expect(await answerLoginState(board, 42, probe)).toEqual({ known: false });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('parseAgentAuthLost', () => {
  it('keeps a well-formed report and refuses anything else', () => {
    expect(parseAgentAuthLost({ agent: 'codex', configDir: '/acc/x', origin: 'start', providerCode: 'unauthorized', at: 5 }))
      .toEqual({ agent: 'codex', configDir: '/acc/x', origin: 'start', providerCode: 'unauthorized', at: 5 });
    expect(parseAgentAuthLost({ agent: 'grok', configDir: null, origin: 'turn', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: '', origin: 'turn', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: null, origin: 'other', at: 1 })).toBeNull();
    expect(parseAgentAuthLost({ agent: 'claude', configDir: null, origin: 'turn', providerCode: 'a b', at: 1 })).not.toHaveProperty('providerCode');
  });
});
