import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { formatPreviewBytes } from '../../../shared/filePreview';
import { svgDrawsTooMuch } from '../../utils/svgDrawing';
import { PreviewFooter } from './PreviewChrome';
import ImageView from './ImageView';

/** Characters of source text the tab draws (as the bot file panel's text
 *  view); a longer SVG that draws too much says it is too large. */
const SOURCE_SHOWN_MAX = 512 * 1024;

/** A version read and checked: the picture built from the checked text, or
 *  the text itself when it shows as source. */
type Checked = { image: string } | { text: string };

/** The encoding an XML parser reads the file in: its byte order mark, a
 *  UTF-16 `<?` with none, or the declaration's `encoding`; else UTF-8. */
function svgEncoding(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  if (b[0] === 0x3c && b[1] === 0x00 && b[2] === 0x3f && b[3] === 0x00) return 'utf-16le';
  if (b[0] === 0x00 && b[1] === 0x3c && b[2] === 0x00 && b[3] === 0x3f) return 'utf-16be';
  const head = String.fromCharCode(...b.subarray(0, 256));
  return /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(head)?.[1] ?? 'utf-8';
}

/** The file's text, in the encoding svgEncoding picks (UTF-8 for one
 *  TextDecoder does not know). */
function decodeSvg(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  try {
    return new TextDecoder(svgEncoding(b)).decode(b);
  } catch {
    return new TextDecoder('utf-8').decode(b);
  }
}

/**
 * An SVG in the preview tab. It shows as a picture through ImageView unless
 * it draws too much (utils/svgDrawing.ts); then it shows as its source text,
 * as the bot file panel does. Every version is read and checked before it
 * shows, and until then the last checked one stays. The picture is built
 * from the text that was checked, never read from the file again.
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
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`preview read ${res.status}`))))
      .then((bytes) => {
        if (cancelled) return;
        const text = decodeSvg(bytes);
        setChecked(svgDrawsTooMuch(text) ? { text } : { image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` });
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
  if ('image' in checked) {
    return <ImageView url={checked.image} size={size} format={format} exists={exists} complete={complete && !failed} />;
  }
  if (checked.text.length > SOURCE_SHOWN_MAX) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]" data-preview-error="too-large">
        {t('preview.error.too-large')}
      </div>
    );
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
