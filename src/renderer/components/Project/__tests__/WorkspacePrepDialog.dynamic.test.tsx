// @vitest-environment jsdom
//
// New workspace setup dialog: the `.env` family is ticked by default, the
// lockfile suggestion fills the setup command, the bot/fan-out copy toggle is
// off, Save sends exactly that with the hash it showed, and a file with
// unapproved commands offers Review instead of Save.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspacePrepSettingsView } from '../../../../shared/workspacePrepSettings';

vi.mock('../../../utils/projectConfigProbe', () => ({
  probeProjectConfig: vi.fn(async () => undefined),
  workspaceProbeCwd: (ws: { metadata?: { cwd?: string } }) => ws.metadata?.cwd,
}));

import { useStore } from '../../../stores';
import WorkspacePrepDialog, { initialCopySelection } from '../WorkspacePrepDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const prepGet = vi.fn();
const prepSave = vi.fn();

const baseView: WorkspacePrepSettingsView = {
  root: '/repo',
  exists: false,
  settings: { copy: [], setup: '', portRange: '', copyIntoAutomated: false },
  copyUnset: true,
  candidates: ['.env', '.env.local', 'secret.key'],
  suggestedSetup: 'npm ci',
};

async function open(view: WorkspacePrepSettingsView): Promise<HTMLElement> {
  prepGet.mockResolvedValue(view);
  await act(async () => root.render(createElement(WorkspacePrepDialog)));
  return container.querySelector('[data-testid="workspace-prep-dialog"]') as HTMLElement;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  prepGet.mockReset();
  prepSave.mockReset().mockResolvedValue({ ok: true, contentHash: 'b'.repeat(64) });
  (window as unknown as { electronAPI: unknown }).electronAPI = { projectConfig: { prepGet, prepSave } };
  act(() => useStore.setState({
    prepDialogWsId: 'ws-1',
    workspaces: [{ id: 'ws-1', name: 'repo', metadata: { cwd: '/repo' } }],
  } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ prepDialogWsId: null, projectDialogWsId: null } as never));
});

describe('initialCopySelection', () => {
  it('ticks only the .env family when copying was never configured, else what the file lists', () => {
    expect(initialCopySelection({ ...baseView, candidates: ['.env', '.env.example', '.env.local', 'secret.key'] })).toEqual(['.env', '.env.local']);
    expect(initialCopySelection({ ...baseView, copyUnset: false, settings: { ...baseView.settings, copy: ['secret.key'] } })).toEqual(['secret.key']);
  });
});

describe('WorkspacePrepDialog', () => {
  it('saves the default selection, the suggested setup and the toggle off, with the shown hash', async () => {
    const panel = await open({ ...baseView, exists: true, contentHash: 'a'.repeat(64) });
    const boxes = [...panel.querySelectorAll('[data-testid="prep-copy-list"] [role="checkbox"]')];
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false']);
    const useSuggested = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Use npm ci') as HTMLButtonElement;
    act(() => useSuggested.click());
    await act(async () => (panel.querySelector('[data-testid="prep-save"]') as HTMLButtonElement).click());
    expect(prepSave).toHaveBeenCalledWith('/repo', { copy: ['.env', '.env.local'], setup: 'npm ci', portRange: '', copyIntoAutomated: false }, 'a'.repeat(64));
    expect(useStore.getState().prepDialogWsId).toBeNull();
  });

  it('offers Review instead of Save over a file with commands not yet approved', async () => {
    const panel = await open({ ...baseView, exists: true, contentHash: 'a'.repeat(64), saveBlocked: 'review-first' });
    expect(panel.querySelector('[data-testid="prep-save"]')).toBeNull();
    expect(panel.querySelector('[data-testid="prep-blocked"]')).not.toBeNull();
    const review = panel.querySelector('.ui-btn-primary') as HTMLButtonElement;
    expect(review.textContent).toBe('Review wmux.json');
    act(() => review.click());
    expect(useStore.getState().projectDialogWsId).toBe('ws-1');
    expect(prepSave).not.toHaveBeenCalled();
  });

  it('keeps a listed file this checkout lacks visible as not found', async () => {
    const panel = await open({ ...baseView, copyUnset: false, settings: { ...baseView.settings, copy: ['.env.gone'] } });
    expect(panel.textContent).toContain('.env.gone');
    expect(panel.textContent).toContain('Not in this checkout');
  });
});
