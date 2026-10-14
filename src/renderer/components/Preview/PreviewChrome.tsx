import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import { Icon } from '../icons';
import { formatZoom, parseZoomInput, stepZoom } from './previewZoom';

const BUTTON = `ui-icon-btn ${HIT_TARGET_24} rounded-[5px] text-[var(--text-sub)] ${FOCUS_RING}`;

function IconMinus() {
  return <Icon size={12}><path d="M3 7h8" /></Icon>;
}

function IconPlusSmall() {
  return <Icon size={12}><path d="M3 7h8M7 3v8" /></Icon>;
}

/** Corners of a frame: fit to the viewport. */
function IconFit() {
  return (
    <Icon size={12}>
      <path d="M2.5 5V2.5H5M9 2.5h2.5V5M11.5 9v2.5H9M5 11.5H2.5V9" />
    </Icon>
  );
}

/**
 * − / zoom % / + / Fit — the preview's one toolbar (#2150), always visible.
 * The field takes a typed percentage; right-click it for 100%.
 */
export function ZoomControls({ zoom, fitted, onZoom, onFit }: {
  zoom: number;
  fitted: boolean;
  onZoom: (zoom: number) => void;
  onFit: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the field; the blur must not then apply what was typed.
  const cancelled = useRef(false);
  useEffect(() => { setDraft(null); }, [zoom]);
  const commit = () => {
    const next = draft === null || cancelled.current ? null : parseZoomInput(draft);
    cancelled.current = false;
    setDraft(null);
    if (next !== null) onZoom(next);
  };
  return (
    <div className="flex items-center gap-0.5 shrink-0" data-preview-zoom>
      <button type="button" className={BUTTON} onClick={() => onZoom(stepZoom(zoom, -1))} title={t('preview.zoomOut')} aria-label={t('preview.zoomOut')}>
        <IconMinus />
      </button>
      <input
        type="text"
        inputMode="decimal"
        className={`w-[52px] h-[22px] px-1 text-center text-[11px] tabular-nums rounded-[5px] bg-transparent text-[var(--text-main)] hover:bg-[var(--hover-fill)] focus:bg-[var(--bg-base)] outline-none ${FOCUS_RING}`}
        value={draft ?? formatZoom(zoom)}
        onFocus={(e) => { setDraft(formatZoom(zoom)); e.currentTarget.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; e.currentTarget.blur(); }
        }}
        onContextMenu={(e) => { e.preventDefault(); onZoom(1); }}
        title={t('preview.zoomField')}
        aria-label={t('preview.zoomField')}
        data-preview-zoom-field
      />
      <button type="button" className={BUTTON} onClick={() => onZoom(stepZoom(zoom, 1))} title={t('preview.zoomIn')} aria-label={t('preview.zoomIn')}>
        <IconPlusSmall />
      </button>
      <button
        type="button"
        className={`${BUTTON} ${fitted ? 'ui-icon-btn-active' : ''}`}
        onClick={onFit}
        aria-pressed={fitted}
        title={t('preview.fit')}
        aria-label={t('preview.fit')}
        data-preview-fit
      >
        <IconFit />
      </button>
    </div>
  );
}

/** The strip under a preview: facts on the left, controls on the right. */
export function PreviewFooter({ info, notice, children }: { info: string; notice?: string | null; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 h-8 px-3 shrink-0 border-t border-[var(--bg-mantle)] bg-[var(--bg-base)] text-[11px] text-[var(--text-sub)]">
      <span className="min-w-0 tabular-nums truncate" data-preview-info title={info}>{info}</span>
      {notice && (
        <span className="min-w-0 truncate text-[var(--attention-text)]" role="status" data-preview-notice title={notice}>{notice}</span>
      )}
      <div className="flex-1" />
      {children}
    </div>
  );
}
