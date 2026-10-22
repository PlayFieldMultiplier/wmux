import { useEffect } from 'react';
import { useStore } from '../../stores';
import { t } from '../../i18n';
import { cancelDictation, clearDictationError, getDictationState, useDictation } from '../../dictation/dictation';
import { DictationConsent } from './DictationConsent';

/**
 * Dictation's app-wide parts, mounted once: the model consent, Esc to cancel
 * a recording wherever focus is (before the key reaches a terminal or a
 * composer), and a toast for each failure.
 */
export function DictationHost() {
  const { error } = useDictation();
  useEffect(() => {
    if (!error) return;
    useStore.getState().pushToast(error === 'mic-denied'
      ? { level: 'warn', message: t('dictation.micDenied'), durationMs: 10_000 }
      : { level: 'error', message: t('dictation.failed', { message: error }) });
    clearDictationError();
  }, [error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const { phase } = getDictationState();
      if (phase !== 'recording' && phase !== 'loading') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelDictation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return <DictationConsent />;
}
