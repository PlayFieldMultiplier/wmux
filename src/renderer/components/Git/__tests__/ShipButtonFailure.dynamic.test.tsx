// @vitest-environment jsdom
//
// A failed ship step in plain words with its one next step: signing (commit
// once unsigned, or how to set it up), a protected branch (Create PR), a
// remote with new commits (the terminal, to pull), a refused key or sign-in
// (sign in again), a folder that is gone (choose it again); anything else is
// a short line over git's output, folded.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const login = vi.hoisted(() => vi.fn(async () => true));
const show = vi.hoisted(() => vi.fn());
vi.mock('../connectGithub', () => ({ GH_LOGIN_COMMAND: 'gh auth login --web', openGithubLoginTab: login }));
vi.mock('../../../utils/showWorkspaces', () => ({ showWorkspaces: show }));

import { ShipButton } from '../ShipButton';
import { useStore } from '../../../stores';

const HEAD = 'c'.repeat(40);
const PIN = { branch: 'feat/x', head: HEAD };
const base = {
  branch: 'feat/x', head: HEAD, detached: false, upstream: 'origin/feat/x', ahead: 0, behind: 0, dirty: 0,
  conflicts: 0, inProgress: false, defaultBranch: 'main', headSubject: 'feat: add x', pr: null,
};

let container: HTMLDivElement;
let root: Root;
let status = { ...base };
const bridge = {
  shipStatus: vi.fn(async (): Promise<unknown> => ({ ok: true, status })),
  shipCommit: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  shipPush: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  shipCreatePr: vi.fn(async (): Promise<unknown> => ({ ok: true })),
};
const pickFolder = vi.fn(async () => ['/new/place/work']);

beforeEach(() => {
  status = { ...base };
  for (const f of [...Object.values(bridge), login, show, pickFolder]) f.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: bridge, dialog: { pickFolder } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (over: Partial<typeof base> = {}) => {
  status = { ...base, ...over };
  act(() => root.render(createElement(ShipButton, { repoPath: '/r', mergeActive: false })));
  await flush();
};
const primary = () => container.querySelector('[data-git-ship-primary]') as HTMLButtonElement;
const failure = () => document.querySelector('[data-git-ship-failure]') as HTMLElement | null;
const fix = (label: string) => document.querySelector(`[data-git-ship-fix="${label}"]`) as HTMLButtonElement;

/** Push from the primary button, answered with `res`. */
const pushFails = async (res: unknown) => {
  bridge.shipPush.mockResolvedValueOnce(res);
  await mount({ ahead: 1 });
  await act(async () => { primary().click(); });
  await flush();
};

/** Open the commit dialog, type a message, submit. */
const commit = async (message: string) => {
  await mount({ dirty: 1 });
  act(() => primary().click());
  const box = document.querySelector('[data-git-ship-text]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set as (v: string) => void;
  act(() => { setter.call(box, message); box.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { (document.querySelector('[data-git-ship-submit]') as HTMLButtonElement).click(); });
  await flush();
};

describe('ShipButton failures', () => {
  it('signing: plain words; "once without signing" re-commits with noSign on that call only', async () => {
    bridge.shipCommit.mockResolvedValueOnce({ ok: false, error: 'error: gpg failed to sign the data', reason: 'signing' });
    await commit('fix: thing');
    expect(failure()?.dataset.gitShipFailure).toBe('signing');
    expect(failure()?.textContent).toContain('Commit signing failed.');
    expect(bridge.shipCommit).toHaveBeenLastCalledWith('/r', 'fix: thing', PIN);
    await act(async () => { fix('Commit once without signing').click(); });
    await flush();
    expect(bridge.shipCommit).toHaveBeenCalledTimes(2);
    expect(bridge.shipCommit).toHaveBeenLastCalledWith('/r', 'fix: thing', PIN, { noSign: true });
    // It landed: the dialog closed.
    expect(document.querySelector('[data-testid="git-ship-commit"]')).toBeNull();
  });

  it('signing: "How to set it up" unfolds the help in place', async () => {
    bridge.shipCommit.mockResolvedValueOnce({ ok: false, error: 'x', reason: 'signing' });
    await commit('m');
    expect(document.querySelector('[data-git-ship-signing-help]')).toBeNull();
    act(() => fix('How to set it up').click());
    expect(document.querySelector('[data-git-ship-signing-help]')?.textContent).toContain('commit.gpgsign');
  });

  it('protected, PR step blocked: no dead Create a PR; the possible next step and the terminal', async () => {
    await pushFails({ ok: false, error: 'remote: GH006: Protected branch update failed', reason: 'protected' });
    expect(failure()?.textContent).toContain("This branch is protected, so you can't push to it directly.");
    expect(fix('Create a PR')).toBeNull();
    expect(document.querySelector('[data-git-ship-next]')?.textContent).toBe('Make a new branch for these commits in the terminal, push it, then create a PR.');
    act(() => fix('Go to terminal').click());
    expect(show).toHaveBeenCalledTimes(1);
    // Git's own output stays one click away, folded.
    const raw = document.querySelector('[data-git-ship-raw]') as HTMLDetailsElement;
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain('GH006');
  });

  it('protected, PR step open (the commits reached the remote meanwhile): Create a PR opens the PR dialog', async () => {
    await pushFails({ ok: false, error: 'GH006', reason: 'protected' });
    // A re-read finds nothing ahead any more, so Create PR can run.
    status = { ...base };
    act(() => root.render(createElement(ShipButton, { repoPath: '/r', mergeActive: false, refreshKey: 1 })));
    await flush();
    expect(document.querySelector('[data-git-ship-next]')).toBeNull();
    expect(fix('Go to terminal')).toBeNull();
    act(() => fix('Create a PR').click());
    await flush();
    expect(document.querySelector('[data-testid="git-ship-createPr"]')).not.toBeNull();
  });

  it('remote ahead: the button opens the terminal to pull', async () => {
    await pushFails({ ok: false, error: '! [rejected] (fetch first)', reason: 'remote-ahead' });
    expect(failure()?.textContent).toContain('The remote has new changes.');
    act(() => fix('Pull in the terminal').click());
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('auth on GitHub: Sign in again opens the gh sign-in', async () => {
    await pushFails({ ok: false, error: 'Permission denied (publickey).', reason: 'auth', forge: 'github' });
    expect(failure()?.textContent).toContain('GitHub refused the key or sign-in.');
    await act(async () => { fix('Sign in again').click(); });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('auth elsewhere: host-neutral words and the terminal', async () => {
    await pushFails({ ok: false, error: 'Authentication failed', reason: 'auth' });
    expect(failure()?.textContent).toContain('The remote refused the key or sign-in.');
    act(() => fix('Go to terminal').click());
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('missing folder: Choose the folder again opens the folder picker and a workspace there', async () => {
    const real = useStore.getState().addWorkspace;
    const add = vi.fn();
    useStore.setState({ addWorkspace: add } as never);
    try {
      await pushFails({ ok: false, error: 'the folder is not there any more', reason: 'missing-folder' });
      expect(failure()?.textContent).toContain("Can't find the working folder. Did you move it?");
      expect(document.querySelector('[data-git-ship-raw]')).toBeNull();
      await act(async () => { fix('Choose the folder again').click(); });
      await flush();
      expect(pickFolder).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith('work', { startupCwd: '/new/place/work' });
      expect(show).toHaveBeenCalledTimes(1);
    } finally {
      useStore.setState({ addWorkspace: real } as never);
    }
  });

  it('a status read on a folder that is gone says so with the same button', async () => {
    bridge.shipStatus.mockResolvedValueOnce({ ok: false, error: 'gone', reason: 'missing-folder' });
    act(() => root.render(createElement(ShipButton, { repoPath: '/r', mergeActive: false })));
    await flush();
    expect(container.querySelector('[data-git-ship-reason]')?.textContent).toBe("Can't find the working folder. Did you move it?");
    expect(container.querySelector('[data-git-ship-fix="missing-folder"]')).not.toBeNull();
  });

  it('anything else: a short line and git output folded, no button', async () => {
    await pushFails({ ok: false, error: 'fatal: something new' });
    expect(failure()?.dataset.gitShipFailure).toBe('other');
    expect(failure()?.querySelector('p')?.textContent).toBe('Push failed.');
    expect(failure()?.querySelector('[data-git-ship-fix]')).toBeNull();
    expect((document.querySelector('[data-git-ship-raw]') as HTMLDetailsElement).textContent).toContain('fatal: something new');
    // Escape puts it away.
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(failure()).toBeNull();
  });
});
