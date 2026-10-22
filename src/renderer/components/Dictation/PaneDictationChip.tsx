import { useT } from '../../hooks/useT';
import { useDictation } from '../../dictation/dictation';
import { paneDictationTarget } from '../../utils/paneDictation';
import { useElapsed } from './DictationButton';

/**
 * The pane's sign that it is being dictated into: a chip in its top-right
 * corner, laid over the terminal (it takes no layout row, so the PTY is never
 * resized) and transparent to the pointer. Nothing when another input
 * dictates. The pane header gets no button: its cluster stays as it is.
 */
export function PaneDictationChip({ ptyId }: { ptyId: string }) {
  const t = useT();
  const dictation = useDictation();
  const mine = dictation.target === paneDictationTarget(ptyId);
  const recording = mine && dictation.phase === 'recording';
  const elapsed = useElapsed(recording ? dictation.startedAt : null);
  if (!mine || (dictation.phase !== 'recording' && dictation.phase !== 'loading' && dictation.phase !== 'transcribing')) return null;
  return (
    <div className="wmux-dictation-chip" role="status" data-pane-dictation={dictation.phase}>
      {recording ? (
        <>
          <span className="wmux-dictation-dot" aria-hidden="true" />
          <span>{t('dictation.paneDictating', { time: elapsed })}</span>
          <span className="wmux-dictation-hint">{t('dictation.paneEsc')}</span>
        </>
      ) : (
        <>
          <span className="wmux-dictation-spin motion-safe:animate-spin" aria-hidden="true" />
          <span>{dictation.phase === 'loading' ? t('dictation.starting') : t('dictation.transcribing')}</span>
        </>
      )}
    </div>
  );
}
