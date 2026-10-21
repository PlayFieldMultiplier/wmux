// ─── Files a bot attached to its card (renderer) ─────────────────────────
//
// A bot may hand the owner files it made (room_post `files`); main keeps a
// copy of each in the room's store and the card carries their descriptions
// (shared/roomFiles.ts). The card shows one chip per file under its bubble —
// a glyph, the name and the size — and a chip opens the file in the side
// panel beside the chat (BotsFilePanel), one side panel at a time, as a
// thread or a worker's terminal. Main serves the stored copy only
// (ROOM_FILE_READ), never a path; Save a copy asks main for a save dialog
// (ROOM_FILE_SAVE). An HTML page opens rendered in a sandboxed frame, with
// Preview / Code in the header.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import type { RoomFile, RoomFileReadResult } from '../../../shared/roomFiles';
import { formatPreviewBytes } from '../../../shared/filePreview';
import { useStore } from '../../stores';
import { roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import { FOCUS_RING } from '../focusRing';
import { IconFile, IconImage, IconX } from '../icons';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import SandboxedHtmlFrame, { sandboxedHtmlDocument } from '../shared/SandboxedHtml';
import { renderBrainMarkdownWhole, type MarkdownOptions } from '../shared/BrainMarkdown';
import { FILE_MARKDOWN_SHOWN_MAX, fileGlyph, fileViewKind, htmlPreviewable, shownText, svgImageSource } from './botsFileView';
import { svgDrawsTooMuch } from '../../utils/svgDrawing';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** How an HTML page shows: rendered, or its source. */
type HtmlView = 'preview' | 'code';

/** The file a side panel shows, and the chip that opened it (focus goes
 *  back there when the panel closes). */
export interface OpenRoomFile {
  workspaceId: string;
  file: RoomFile;
  opener?: HTMLElement | null;
}

/** A bot card's files: a chip each, wrapping; nothing for a card without. */
export function CardFiles({ card, t, shownId, onOpen }: {
  card: Pick<RoomCardData, 'workspaceId' | 'files'>;
  t: T;
  /** The file the side panel shows now (its chip reads as pressed). */
  shownId?: string | null;
  onOpen: (open: OpenRoomFile) => void;
}) {
  const files = card.files ?? [];
  if (files.length === 0) return null;
  return (
    <div className="wmux-bots-files" data-bots-files>
      {files.map((file) => {
        const size = formatPreviewBytes(file.bytes);
        const label = t('botsPage.file.open', { name: file.name, size });
        const shown = shownId === file.id;
        return (
          <button
            key={file.id}
            type="button"
            data-bots-file={file.id}
            aria-label={label}
            aria-pressed={shown}
            title={file.name}
            onClick={(e) => onOpen({ workspaceId: card.workspaceId, file, opener: e.currentTarget })}
            className={`wmux-bots-file-chip ${shown ? 'is-open' : ''} ${FOCUS_RING}`}
          >
            <span className="wmux-bots-file-glyph" aria-hidden="true">
              {fileGlyph(fileViewKind(file)) === 'image' ? <IconImage size={13} /> : <IconFile size={13} />}
            </span>
            <span className="wmux-bots-file-name">{file.name}</span>
            <span className="wmux-bots-file-size">{size}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Markdown in the panel reads as the chat does (links, rich code). */
const PANEL_MARKDOWN: MarkdownOptions = { links: true, richCode: true, strictEmphasis: true };

function FileNote({ children, testId, status }: { children: React.ReactNode; testId: string; status?: boolean }) {
  return <p className="wmux-bots-file-note" data-bots-file-note={testId} role={status ? 'status' : undefined}>{children}</p>;
}

function TextView({ text, t, total }: { text: string; t: T; total: number }) {
  const shown = shownText(text);
  return (
    <>
      {shown.cut && <FileNote testId="cut">{t('botsPage.file.cut', { shown: formatPreviewBytes(shown.shownBytes ?? shown.text.length), size: formatPreviewBytes(total) })}</FileNote>}
      <pre className="wmux-bots-file-text font-mono" data-bots-file-view="text">{shown.text}</pre>
    </>
  );
}

function MarkdownView({ text, t, total }: { text: string; t: T; total: number }) {
  // A document past the panel's markdown size or the renderer's budget
  // reads as text, never cut short without a word.
  const nodes = useMemo(() => (text.length > FILE_MARKDOWN_SHOWN_MAX ? null : renderBrainMarkdownWhole(text, PANEL_MARKDOWN)), [text]);
  if (!nodes) {
    return (
      <>
        <FileNote testId="as-text">{t('botsPage.file.asText')}</FileNote>
        <TextView text={text} t={t} total={total} />
      </>
    );
  }
  return <div className="wmux-bots-file-markdown wmux-bots-prose" data-bots-file-view="markdown">{nodes}</div>;
}

/** A read HTML page as the preview frame's document: main sent it as text,
 *  it is within the panel's text size and it could be made inert. Null
 *  otherwise (it shows as its source, with no toggle). */
function htmlPreviewDocument(read: RoomFileReadResult | null): string | null {
  if (!read?.ok || fileViewKind(read.file) !== 'html' || read.text === undefined || !htmlPreviewable(read.text)) return null;
  return sandboxedHtmlDocument(read.text);
}

/** The file itself, by its kind and what main sent (text or a data URL):
 *  markdown formatted as in the chat, an HTML page rendered in a sandboxed
 *  frame (or its source, by the header's toggle or past the panel's text
 *  size), a picture as an <img>, any other text as plain text, and anything
 *  else its name, its size and Save a copy. */
function FileBody({ read, t, htmlView, htmlDoc }: { read: Extract<RoomFileReadResult, { ok: true }>; t: T; htmlView: HtmlView; htmlDoc: string | null }) {
  const { file, text, dataUrl } = read;
  const kind = fileViewKind(file);
  // Counting an SVG's drawing parses it: once per read, not per render.
  const svgSrc = useMemo(() => (kind === 'svg' && read.text !== undefined && !svgDrawsTooMuch(read.text) ? svgImageSource(read) : null), [kind, read]);
  if (kind === 'markdown' && text !== undefined) return <div className="wmux-bots-file-scroll"><MarkdownView text={text} t={t} total={file.bytes} /></div>;
  if (htmlDoc !== null && htmlView === 'preview') {
    return (
      <div className="wmux-bots-file-html" data-bots-file-view="html">
        <SandboxedHtmlFrame srcDoc={htmlDoc} title={t('botsPage.html.frame', { name: file.name })} />
        <FileNote testId="links-off">{t('botsPage.html.linksOff')}</FileNote>
      </div>
    );
  }
  if (kind === 'svg') {
    const src = svgSrc;
    if (src) return <div className="wmux-bots-file-image" data-bots-file-view="image"><img src={src} alt={file.name} /></div>;
  }
  if (kind === 'image' && dataUrl) return <div className="wmux-bots-file-image" data-bots-file-view="image"><img src={dataUrl} alt={file.name} /></div>;
  if (text !== undefined) return <div className="wmux-bots-file-scroll"><TextView text={text} t={t} total={file.bytes} /></div>;
  return (
    <div className="wmux-bots-file-scroll" data-bots-file-view="other">
      <p className="text-[13px] text-[var(--text-main)]">{file.name}</p>
      <p className="text-[11px] tabular-nums text-[var(--text-muted)]">{formatPreviewBytes(file.bytes)}</p>
      <FileNote testId="no-preview">{t('botsPage.file.noPreview')}</FileNote>
    </div>
  );
}

/** A bot's file beside its chat: a 44px header (the name, the size, Save a
 *  copy and Close) and the file under it. Escape or Close closes it. */
export default function BotsFilePanel({ open, api, t, onClose, style }: {
  open: OpenRoomFile;
  api?: RoomsApi | null;
  t: T;
  onClose: () => void;
  /** The panel's width beside the chat (the splitter's). */
  style?: React.CSSProperties;
}) {
  const { workspaceId, file } = open;
  const bridge = api === undefined ? roomsApi() : api;
  const [read, setRead] = useState<RoomFileReadResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [htmlView, setHtmlView] = useState<HtmlView>('preview');
  // Parsing a page (up to the panel's text size) is once per read.
  const htmlDoc = useMemo(() => htmlPreviewDocument(read), [read]);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    setRead(null);
    setHtmlView('preview');
    const get = bridge?.fileRead;
    if (!get) {
      setRead({ ok: false, error: t('botsPage.file.unavailable') });
      return;
    }
    get({ workspaceId, fileId: file.id })
      .then((r) => { if (live) setRead(r); })
      .catch((err: unknown) => { if (live) setRead({ ok: false, error: err instanceof Error ? err.message : String(err) }); });
    return () => { live = false; };
    // `t` changes with the locale only; a new file or room is a new read.
  }, [bridge, workspaceId, file.id]);

  // Focus moves to the panel when it opens (under a 720px chat area it
  // covers the chat) and, when it closes from inside, back to the chip that
  // opened it — or the composer, when that chip is gone (it was in a thread
  // this panel replaced).
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButtonRef.current?.focus({ preventScroll: true }); }, []);
  const close = () => {
    const active = document.activeElement;
    const inside = !!asideRef.current?.contains(active) || active === document.body || active === null;
    const area = asideRef.current?.closest('.wmux-bots-chat-area');
    onClose();
    if (!inside) return;
    if (open.opener?.isConnected) open.opener.focus();
    else area?.querySelector<HTMLElement>('[data-testid="bots-composer-input"]')?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  // Escape closes it while the focus is on the Bots chat or its panel. It
  // listens on the window, so every document listener has had the key
  // first, and one that took it (a dialog, a popover, a menu, the
  // Notifications panel) stopped it or marked it handled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      const area = asideRef.current?.closest('.wmux-bots-chat-area');
      if (active && active !== document.body && !area?.contains(active)) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const save = async () => {
    const put = bridge?.fileSave;
    if (!put) return;
    setSaving(true);
    try {
      const r = await put({ workspaceId, fileId: file.id });
      if (r.ok) useStore.getState().pushToast({ message: t('botsPage.file.saved', { path: r.savedTo }), level: 'info' });
      else if (!r.canceled) useStore.getState().pushToast({ message: t('botsPage.file.saveFailed', { error: r.error ?? '' }).trim(), level: 'error' });
    } catch (err) {
      useStore.getState().pushToast({ message: t('botsPage.file.saveFailed', { error: err instanceof Error ? err.message : String(err) }), level: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside ref={asideRef} className="wmux-bots-side" data-bots-file-panel={file.id} aria-label={t('botsPage.file.panel', { name: file.name })} style={style}>
      <div className="wmux-bots-worker-head">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]" title={file.name}>{file.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{`· ${formatPreviewBytes(file.bytes)}`}</span>
        </span>
        {htmlDoc !== null && (
          <SegmentedControl<HtmlView>
            value={htmlView}
            onValueChange={setHtmlView}
            ariaLabel={t('botsPage.html.view')}
            className="wmux-html-view-toggle"
            data-testid="bots-file-html-view"
            options={[
              { value: 'preview', label: t('botsPage.html.preview') },
              { value: 'code', label: t('botsPage.html.code') },
            ]}
          />
        )}
        {bridge?.fileSave && (
          <Button size="sm" variant="secondary" data-bots-file-save disabled={saving} onClick={() => void save()}>
            {t('botsPage.file.save')}
          </Button>
        )}
        <button
          ref={closeButtonRef}
          type="button"
          data-bots-file-close
          onClick={close}
          aria-label={t('botsPage.file.close')}
          title={t('botsPage.file.close')}
          className={`wmux-bots-icon-button ${FOCUS_RING}`}
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="wmux-bots-file-body" data-bots-file-state={read === null ? 'loading' : read.ok ? 'ready' : 'error'} aria-busy={read === null}>
        {read === null ? (
          <FileNote testId="loading" status>{t('botsPage.file.loading')}</FileNote>
        ) : !read.ok ? (
          <FileNote testId="error" status>{t('botsPage.file.error', { error: read.error })}</FileNote>
        ) : (
          <FileBody read={read} t={t} htmlView={htmlView} htmlDoc={htmlDoc} />
        )}
      </div>
    </aside>
  );
}
