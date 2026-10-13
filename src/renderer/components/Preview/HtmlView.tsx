import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';
import { HTML_PREVIEW_PARTITION, formatPreviewBytes, type PreviewLinkEvent } from '../../../shared/filePreview';
import { PreviewFooter } from './PreviewChrome';

const CHIP = `inline-flex items-center h-[22px] px-2 rounded-[5px] text-[11px] shrink-0 ${FOCUS_RING}`;

/**
 * A local HTML page in a sandboxed <webview> on the `preview-html` partition
 * (main/preview/previewHtml.ts): never the app renderer, never a browser pane
 * (no data-surface-id, no popups, no CDP registration). Offline until the
 * person allows the network for this tab. When the page's folder changes it
 * reloads in place, which keeps the scroll, and gives back the focus it had
 * before the load, so an agent rewriting a report never pulls the cursor out
 * of the terminal. A link the page tries to open is held here for the person
 * to open; nothing opens on its own.
 */
export default function HtmlView({ token, url, version, size, exists }: {
  token: string;
  url: string;
  version: number;
  size: number;
  exists: boolean;
}) {
  const t = useT();
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [network, setNetwork] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  /** Focus to give back when a load we started ends with the page holding it. */
  const focusBefore = useRef<HTMLElement | null>(null);
  const firstVersion = useRef(version);

  const noteFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== webviewRef.current && active !== document.body) {
      focusBefore.current = active;
    }
  };

  useEffect(() => {
    noteFocus();
    const webview = webviewRef.current;
    if (!webview) return;
    const onLoaded = () => {
      const previous = focusBefore.current;
      focusBefore.current = null;
      if (previous?.isConnected && document.activeElement === webview) previous.focus();
    };
    webview.addEventListener('did-finish-load', onLoaded);
    return () => { webview.removeEventListener('did-finish-load', onLoaded); };
  }, []);

  // A settled change in the page's folder: reload in place.
  useEffect(() => {
    if (version === firstVersion.current) return;
    const webview = webviewRef.current;
    if (!webview || !exists) return;
    noteFocus();
    try { webview.reload(); } catch { /* not attached yet: the first load is still coming */ }
  }, [version, exists]);

  useEffect(() => {
    const api = window.electronAPI?.preview;
    if (!api) return;
    return api.onLink((event: PreviewLinkEvent) => {
      if (event.token === token) setLink(event.url);
    });
  }, [token]);

  const toggleNetwork = () => {
    const next = !network;
    void window.electronAPI?.preview?.setNetwork(token, next).then((ok) => {
      if (!ok) return;
      setNetwork(next);
      noteFocus();
      try { webviewRef.current?.reload(); } catch { /* reloads on attach anyway */ }
    });
  };

  const linkLabel = (() => {
    if (!link) return '';
    try {
      const u = new URL(link);
      return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return link;
    }
  })();

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="relative flex-1 min-h-0 bg-white">
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={url}
          partition={HTML_PREVIEW_PARTITION}
          // Lets a target=_blank link reach main, which refuses every popup
          // and hands an http(s) one to this tab's footer.
          allowpopups={'true' as unknown as boolean}
          className="absolute inset-0 w-full h-full"
          data-preview-html
        />
      </div>
      <PreviewFooter
        info={`HTML · ${formatPreviewBytes(size)}`}
        notice={!exists ? t('preview.waiting') : null}
      >
        {link && (
          <span className="flex items-center gap-1 min-w-0" data-preview-link>
            <span className="min-w-0 truncate text-[var(--text-sub)]" title={link}>{t('preview.link.held', { url: linkLabel })}</span>
            <button
              type="button"
              className={`${CHIP} bg-[var(--bg-surface)] text-[var(--text-main)] hover:bg-[var(--hover-fill)]`}
              onClick={() => { void window.electronAPI.shell.openExternal(link); setLink(null); }}
              data-preview-link-open
            >
              {t('preview.link.open')}
            </button>
            <button
              type="button"
              className={`${CHIP} text-[var(--text-sub)] hover:bg-[var(--hover-fill)]`}
              onClick={() => setLink(null)}
              aria-label={t('preview.link.dismiss')}
              title={t('preview.link.dismiss')}
            >
              <IconX size={11} />
            </button>
          </span>
        )}
        <button
          type="button"
          className={`${CHIP} ${network ? 'ui-icon-btn-active text-[var(--text-main)]' : 'text-[var(--text-sub)] hover:bg-[var(--hover-fill)]'}`}
          aria-pressed={network}
          onClick={toggleNetwork}
          title={network ? t('preview.network.onHint') : t('preview.network.offHint')}
          data-preview-network
        >
          {network ? t('preview.network.on') : t('preview.network.off')}
        </button>
      </PreviewFooter>
    </div>
  );
}
