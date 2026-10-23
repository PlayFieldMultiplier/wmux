import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { cancelDictation, getDictationState, toggleDictation, useDictation } from '../../dictation/dictation';
import { IconMic } from '../icons';
import { FOCUS_RING } from '../focusRing';

/** Dictation needs main's model store (preload); without it there is no mic. */
export function dictationAvailable(): boolean {
  return !!window.electronAPI?.dictation;
}

/** `m:ss` for the recording clock. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The recording's elapsed time, ticking once a second while `startedAt` is set. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return formatElapsed(startedAt === null ? 0 : now - startedAt);
}

/**
 * A composer's mic: one click records, the next stops and hands the text to
 * `onText` (which puts it in the box; nothing is sent). While recording a dot
 * and the elapsed time sit beside it; while the engine starts or transcribes
 * it shows a quiet spinner. Esc cancels (DictationHost).
 */
export function DictationButton({ target, onText, disabled, className }: {
  /** This composer's dictation key (e.g. `chat:<pane>`). */
  target: string;
  onText: (text: string) => void;
  disabled?: boolean;
  /** The host composer's own icon-button class. */
  className: string;
}) {
  const t = useT();
  const dictation = useDictation();
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const mine = dictation.target === target;
  const recording = mine && dictation.phase === 'recording';
  const busy = mine && (dictation.phase === 'loading' || dictation.phase === 'transcribing');
  const elsewhere = dictation.phase !== 'idle' && !mine;
  const elapsed = useElapsed(recording ? dictation.startedAt : null);

  // A composer that goes away takes its recording with it.
  useEffect(() => () => {
    const now = getDictationState();
    if (now.target === target && (now.phase === 'recording' || now.phase === 'loading')) cancelDictation();
  }, [target]);

  const label = recording ? t('dictation.stop')
    : dictation.phase === 'loading' && mine ? t('dictation.starting')
      : busy ? t('dictation.transcribing') : t('dictation.start');
  return (
    <>
      {recording && (
        <span className="wmux-dictation-clock" role="timer" data-dictation-clock>
          <span className="wmux-dictation-dot" aria-hidden="true" />
          {elapsed}
        </span>
      )}
      <button
        type="button"
        data-dictation-button={target}
        data-state={recording ? 'recording' : busy ? 'busy' : 'idle'}
        aria-label={label}
        title={label}
        aria-pressed={recording}
        aria-busy={busy || undefined}
        disabled={disabled || busy || elsewhere}
        onClick={() => void toggleDictation(target, (text) => onTextRef.current(text))}
        className={`${className} wmux-dictation-btn ${FOCUS_RING}`}
      >
        {busy ? <span className="wmux-dictation-spin motion-safe:animate-spin" aria-hidden="true" /> : <IconMic size={16} />}
      </button>
    </>
  );
}
