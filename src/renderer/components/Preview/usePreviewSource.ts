import { useEffect, useState } from 'react';
import {
  htmlPreviewUrl,
  previewUrl,
  type PreviewChangedEvent,
  type PreviewKind,
  type PreviewOpenResult,
} from '../../../shared/filePreview';

type FailReason = Extract<PreviewOpenResult, { ok: false }>['reason'] | 'unavailable';

export type PreviewSource =
  | { status: 'loading' }
  | { status: 'error'; reason: FailReason }
  | {
      status: 'ready';
      token: string;
      kind: PreviewKind;
      mime: string;
      /** URL of the newest settled version. Viewers swap to it only once it loads. */
      url: string;
      exists: boolean;
      /** False while the newest bytes on disk are torn; `url` still shows the last whole version. */
      complete: boolean;
      size: number;
      mtimeMs: number;
      version: number;
    };

/**
 * Opens a preview token for `filePath` (#2150) and follows the file: every
 * settled change on disk yields a new `url` (the version is in it, so no cache
 * can hand back the old bytes). The token is released on unmount.
 */
export function usePreviewSource(filePath: string): PreviewSource {
  const [source, setSource] = useState<PreviewSource>({ status: 'loading' });

  useEffect(() => {
    const api = window.electronAPI?.preview;
    if (!filePath || !api) {
      setSource({ status: 'error', reason: 'unavailable' });
      return;
    }
    setSource({ status: 'loading' });
    let token: string | null = null;
    let disposed = false;
    const unsubscribe = api.onChanged((event: PreviewChangedEvent) => {
      if (disposed || event.token !== token) return;
      setSource((prev) => prev.status !== 'ready' ? prev : {
        ...prev,
        // Only a whole file is worth loading; otherwise keep showing the last one.
        // An html page keeps its URL: the view reloads it in place on a new version.
        url: prev.kind === 'html' ? prev.url
          : event.exists && event.complete ? previewUrl(event.token, filePath, event.version) : prev.url,
        exists: event.exists,
        complete: event.complete,
        size: event.exists && event.complete ? event.size : prev.size,
        mtimeMs: event.mtimeMs,
        version: event.version,
      });
    });
    api.open(filePath).then((result) => {
      if (disposed) {
        if (result.ok) void api.close(result.token);
        return;
      }
      if (!result.ok) {
        setSource({ status: 'error', reason: result.reason });
        return;
      }
      token = result.token;
      setSource({
        status: 'ready',
        token: result.token,
        kind: result.kind,
        mime: result.mime,
        url: result.kind === 'html'
          ? htmlPreviewUrl(result.token, result.path ?? '')
          : previewUrl(result.token, filePath, result.version),
        exists: result.exists,
        complete: result.complete,
        size: result.size,
        mtimeMs: result.mtimeMs,
        version: result.version,
      });
    }).catch(() => {
      if (!disposed) setSource({ status: 'error', reason: 'unavailable' });
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (token) void api.close(token);
    };
  }, [filePath]);

  return source;
}
