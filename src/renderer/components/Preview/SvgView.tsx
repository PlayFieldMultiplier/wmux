import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { formatPreviewBytes } from '../../../shared/filePreview';
import { svgDrawsTooMuch } from '../../utils/svgDrawing';
import { PreviewFooter } from './PreviewChrome';
import ImageView from './ImageView';

/** A version read and checked: `text` is set when it shows as source. */
interface Checked {
  url: string;
  text: string | null;
}

/**
 * An SVG in the preview tab. It shows as a picture through ImageView unless
 * it draws too much (utils/svgDrawing.ts); then it shows as its source text,
 * as the bot file panel does. Every version is read and checked before it
 * shows, and until then the last checked one stays.
 */
export default function SvgView({ url, size, format, exists, complete }: {
  url: string;
  size: number;
  format: string;
  exists: boolean;
  complete: boolean;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Checked | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`preview read ${res.status}`))))
      .then((text) => {
        if (cancelled) return;
        setChecked({ url, text: svgDrawsTooMuch(text) ? text : null });
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [url]);

  if (!checked) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
        {failed ? t('preview.error.load') : t('preview.loading')}
      </div>
    );
  }
  // A newer version that could not be read leaves the last one, with its notice.
  if (checked.text === null) {
    return <ImageView url={checked.url} size={size} format={format} exists={exists} complete={complete && !failed} />;
  }
  const notice = !exists ? t('preview.waiting') : !complete || failed ? t('preview.updateFailed') : null;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-auto">
        <pre
          className="p-4 font-mono text-xs text-[var(--text-main)] whitespace-pre-wrap break-all select-text"
          data-preview-svg-source
        >
          {checked.text}
        </pre>
      </div>
      <PreviewFooter info={`${formatPreviewBytes(size)} · ${format}`} notice={notice} />
    </div>
  );
}
