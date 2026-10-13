import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import { IconCopy, IconExternalLink, IconFolder } from '../icons';
import { previewFileName } from '../../../shared/filePreview';
import { usePreviewSource } from './usePreviewSource';
import ImageView from './ImageView';
import PdfView from './PdfView';

const ACTION = `ui-icon-btn ${HIT_TARGET_24} rounded-[5px] ${FOCUS_RING}`;

function parentDir(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/** Last two segments, the way the editor tab's header shows a path. */
function shortPath(filePath: string): string {
  const sep = filePath.includes('/') ? '/' : '\\';
  const parts = filePath.split(sep).filter(Boolean);
  return parts.length <= 3 ? filePath : `…${sep}${parts.slice(-2).join(sep)}`;
}

/**
 * A read-only image or PDF tab in the pane's work area (#2150). It follows
 * the file on disk: when an agent rewrites it, the view updates in place and
 * keeps its zoom and position. It never takes the focus.
 */
export default function PreviewPanel({ filePath, isActive }: { filePath: string; isActive: boolean }) {
  const t = useT();
  const source = usePreviewSource(filePath);
  const name = previewFileName(filePath);
  const format = (name.split('.').pop() ?? '').toUpperCase();

  return (
    <div
      className="absolute inset-0 flex flex-col bg-[var(--bg-base)]"
      style={{ display: isActive ? 'flex' : 'none' }}
      data-preview-panel
    >
      <div className="flex items-center gap-2 pl-3 pr-1.5 h-8 bg-[var(--bg-surface)] border-b border-[var(--bg-mantle)] shrink-0 text-xs">
        <span className="text-[var(--text-main)] font-semibold truncate" title={filePath}>{name}</span>
        <span className="text-[var(--text-muted)] truncate text-[10px]" title={filePath}>{shortPath(filePath)}</span>
        <div className="flex-1" />
        <button
          type="button"
          className={ACTION}
          onClick={() => { void window.electronAPI.shell.openPath(filePath); }}
          title={t('preview.openExternal')}
          aria-label={t('preview.openExternal')}
          data-preview-action="open"
        >
          <IconExternalLink size={13} />
        </button>
        <button
          type="button"
          className={ACTION}
          onClick={() => { void window.electronAPI.shell.openPath(parentDir(filePath)); }}
          title={t('preview.openFolder')}
          aria-label={t('preview.openFolder')}
          data-preview-action="folder"
        >
          <IconFolder size={13} />
        </button>
        <button
          type="button"
          className={ACTION}
          onClick={() => { void window.clipboardAPI?.writeText(filePath); }}
          title={t('preview.copyPath')}
          aria-label={t('preview.copyPath')}
          data-preview-action="copy-path"
        >
          <IconCopy size={13} />
        </button>
      </div>

      {source.status === 'loading' && (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">{t('preview.loading')}</div>
      )}
      {source.status === 'error' && (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]" data-preview-error={source.reason}>
          {t(`preview.error.${source.reason}`)}
        </div>
      )}
      {source.status === 'ready' && source.kind === 'image' && (
        <ImageView url={source.url} size={source.size} format={format} exists={source.exists} complete={source.complete} />
      )}
      {source.status === 'ready' && source.kind === 'pdf' && (
        <PdfView url={source.url} size={source.size} exists={source.exists} complete={source.complete} />
      )}
    </div>
  );
}
