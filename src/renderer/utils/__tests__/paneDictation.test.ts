// @vitest-environment jsdom
//
// "Dictate into this pane" writes the text through the terminal's paste path:
// a bracketed paste when the app asked for one, never an Enter; without
// bracketed paste mode the lines are joined so no line break submits them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import type { Pane, Workspace } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
  terminals: new Map<string, unknown>(),
  toggleDictation: vi.fn(),
  stopDictation: vi.fn(),
  state: { phase: 'idle', target: null as string | null },
  noteInput: vi.fn(),
}));

/** A terminal whose screen shows `lines`. */
function screen(lines: string[], modes = { bracketedPasteMode: true }) {
  return { modes, rows: lines.length, buffer: { active: { viewportY: 0, getLine: (y: number) => ({ translateToString: () => lines[y] ?? '' }) } } };
}
vi.mock('../../hooks/useTerminal', () => ({ terminalRegistry: mocks.terminals }));
vi.mock('../../daemon/daemonLinkNotice', () => ({ notePaneUserInput: mocks.noteInput }));
vi.mock('../../dictation/dictation', () => ({
  toggleDictation: mocks.toggleDictation,
  stopDictation: mocks.stopDictation,
  getDictationState: () => mocks.state,
}));

import { dictateIntoActivePane, paneDictationText, writeDictationToPty } from '../paneDictation';

const write = vi.fn();

function seedPane(): void {
  const leaf = {
    id: 'p1', type: 'leaf', activeSurfaceId: 's1',
    surfaces: [{ id: 's1', ptyId: 'pty-1', title: 'zsh', shell: 'zsh', surfaceType: 'terminal' }],
  } as unknown as Pane;
  useStore.setState({ workspaces: [{ id: 'w1', name: 'w', rootPane: leaf, activePaneId: 'p1' } as Workspace], activeWorkspaceId: 'w1', toasts: [] });
}

beforeEach(() => {
  write.mockClear();
  mocks.toggleDictation.mockClear();
  mocks.stopDictation.mockClear();
  mocks.state = { phase: 'idle', target: null };
  mocks.terminals.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write } };
});
afterEach(() => {
  useStore.setState(useStore.getInitialState());
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('paneDictationText', () => {
  it('drops a trailing newline and keeps inner lines in a bracketed paste', () => {
    expect(paneDictationText('first line\nsecond line\n', true)).toBe('first line\nsecond line');
  });

  it('joins the lines with spaces without bracketed paste mode', () => {
    expect(paneDictationText('first line\r\n second line\n\nthird\n', false)).toBe('first line second line third');
  });
});

describe('writeDictationToPty', () => {
  it('writes a bracketed paste with no Enter when the pane asked for one', async () => {
    await writeDictationToPty('pty-1', 'run the tests\nthen push\n', { bracketedPasteMode: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('pty-1', '\x1b[200~run the tests\nthen push\x1b[201~');
  });

  it('writes one line, no CR, when bracketed paste mode is off', async () => {
    await writeDictationToPty('pty-1', 'run the tests\nthen push\n', { bracketedPasteMode: false });
    expect(write).toHaveBeenCalledWith('pty-1', 'run the tests then push');
    expect(write.mock.calls.flat().join('')).not.toMatch(/[\r\n]/);
  });
});

describe('dictateIntoActivePane', () => {
  it('dictates into the focused pane and pastes the text there', async () => {
    seedPane();
    mocks.terminals.set('pty-1', screen(['~ % ']));
    dictateIntoActivePane();
    expect(mocks.toggleDictation).toHaveBeenCalledWith('pane:pty-1', expect.any(Function));
    const deliver = mocks.toggleDictation.mock.calls[0][1] as (text: string) => void;
    deliver('hello world\n');
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith('pty-1', '\x1b[200~hello world\x1b[201~');
    expect(mocks.noteInput).toHaveBeenCalledWith('pty-1');
  });

  it('types nothing into a dialog that took the pane while the owner spoke', async () => {
    seedPane();
    mocks.terminals.set('pty-1', screen(['Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit', '', 'Enter to confirm · Esc to cancel']));
    dictateIntoActivePane();
    (mocks.toggleDictation.mock.calls[0][1] as (text: string) => void)('yes');
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('The pane is showing a dialog, so the dictated text was not typed.');
  });

  it('stops a pane dictation that is recording, wherever focus went', () => {
    seedPane();
    mocks.state = { phase: 'recording', target: 'pane:pty-9' };
    dictateIntoActivePane();
    expect(mocks.stopDictation).toHaveBeenCalledTimes(1);
    expect(mocks.toggleDictation).not.toHaveBeenCalled();
  });

  it('says so when no terminal pane has focus', () => {
    seedPane();
    dictateIntoActivePane();
    expect(mocks.toggleDictation).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Focus a terminal pane to dictate into it.');
  });
});
