// An unbound workspace's browser call used the shared default Chrome profile:
// main says so once per workspace per run of the app, and this shows one
// toast. Its action binds the last-used profile only when the user clicks it.
import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';

export function showChromeProfileFallbackToast(info: { workspaceId: string; suggested?: string }): string {
  const suggested = info.suggested;
  return useStore.getState().pushToast({
    message: t('chromeProfiles.fallbackToast'),
    level: 'info',
    target: { workspaceId: info.workspaceId },
    ...(suggested
      ? {
          action: {
            label: t('chromeProfiles.useLastUsed', { name: suggested }),
            onClick: () => {
              void window.electronAPI?.browser?.chromeProfiles?.bind(info.workspaceId, suggested).catch(() => undefined);
            },
          },
        }
      : {}),
  });
}

export function useChromeProfileFallbackToast(): void {
  useEffect(() => window.electronAPI?.browser?.chromeProfiles?.onFallback?.(showChromeProfileFallbackToast), []);
}
