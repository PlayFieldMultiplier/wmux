// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenUsageView, type TokenUsageViewProps } from '../tabs/TokenUsageTab';
import { t as translate } from '../../../i18n';

// The saved-profile list is replaced by one button that reports an applied profile.
vi.mock('../tabs/TokenUsageTab/profiles/SavedSurfaceProfiles', () => ({
  SavedSurfaceProfiles: ({ onApplied }: { onApplied?: () => void }) =>
    createElement('button', { 'data-testid': 'fake-apply-profile', onClick: () => onApplied?.() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TokenUsageView after a saved profile is applied', () => {
  it('reloads the open Custom panel instead of keeping the old inventory', async () => {
    const readInventory = vi.fn(async ({ provider }: { provider: string }) => ({
      provider, cliVersion: '1.0.0', versionSupported: true, writable: true, items: [], warnings: [], scannedAtMs: 0,
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      tokenUsage: { readInventory, readQuota: vi.fn(async () => ({ readings: [] })), agySensorStatus: vi.fn(async () => null) },
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    Element.prototype.scrollIntoView = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TokenUsageView, {
        bindings: { Planner: { agent: 'claude' } },
        onApply: () => undefined,
        onOpenTab: () => undefined,
        t: translate as unknown as TokenUsageViewProps['t'],
      }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="token-customize-button"]') as HTMLButtonElement).click();
    });
    const panelReads = () => readInventory.mock.calls.length;
    const before = panelReads();

    await act(async () => {
      (container.querySelector('[data-testid="fake-apply-profile"]') as HTMLButtonElement).click();
    });

    // One read refreshes the surface badge; the remounted panel reads again.
    expect(panelReads()).toBeGreaterThanOrEqual(before + 2);

    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
});
