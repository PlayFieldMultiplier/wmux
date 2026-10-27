// @vitest-environment jsdom
//
// A conversation whose folder is gone (a removed worktree, `cwdMissing`): the
// chip names the folder and copies the exact, cd-guarded resume line. It never
// types into the pane and never offers the picker, which would open in a folder
// that cannot list that conversation.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import ResumeInfoChip from '../ResumeInfoChip';
import type { ResumeBinding } from '../../../../shared/agentResume';

const ID = 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a';
const lost = (cwd: string): ResumeBinding => ({ agent: 'claude', sessionId: ID, cwd, ts: 1, cwdMissing: true });

let container: HTMLDivElement;
let root: Root;
const writeLaunch = vi.fn(() => Promise.resolve());
const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeLaunch.mockClear();
  writeText.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', pty: { writeLaunch } };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function openChip(binding: ResumeBinding, paneCwds: string[] = ['/Users/me']): HTMLButtonElement[] {
  act(() => {
    root.render(React.createElement(ResumeInfoChip, { ptyId: 'pty-1', binding, paneCwds }));
  });
  act(() => { (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
  return [...container.querySelectorAll('button')];
}

describe('ResumeInfoChip — lost folder', () => {
  it('copies the cd-guarded exact line, types nothing and offers no picker', async () => {
    const buttons = openChip(lost('/repo/wt-gone'));
    expect(container.textContent).toContain('Claude conversation a1b2c3d4 was in /repo/wt-gone, which no longer exists');
    expect(buttons.some((b) => b.textContent?.includes('Pick a Claude session'))).toBe(false);
    const copy = buttons.find((b) => b.textContent?.includes('Copy resume command'));
    expect(copy).toBeDefined();
    await act(async () => { copy?.click(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(`cd -- '/repo/wt-gone' && claude --resume ${ID}`);
    expect(writeLaunch).not.toHaveBeenCalled();
  });

  it('a pane cwd that still names the gone folder gets the notice and Copy, not Resume', async () => {
    const buttons = openChip(lost('/repo/wt-gone'), ['/repo/wt-gone']);
    expect(container.textContent).toContain('which no longer exists');
    expect(buttons.some((b) => /Resume Claude/.test(b.textContent ?? '') && !b.hasAttribute('aria-expanded'))).toBe(false);
    const copy = buttons.find((b) => b.textContent?.includes('Copy resume command'));
    await act(async () => { copy?.click(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(`cd -- '/repo/wt-gone' && claude --resume ${ID}`);
    expect(writeLaunch).not.toHaveBeenCalled();
  });

  it('an unusable folder shows the folder and UUID only, with no line to copy', () => {
    const buttons = openChip(lost("/repo/it's-gone"));
    expect(container.textContent).toContain("was in /repo/it's-gone, which no longer exists");
    expect(container.textContent).toContain(ID);
    expect(container.querySelector('code')).toBeNull();
    expect(buttons.some((b) => /Copy resume command|Pick a Claude session/.test(b.textContent ?? ''))).toBe(false);
  });
});
