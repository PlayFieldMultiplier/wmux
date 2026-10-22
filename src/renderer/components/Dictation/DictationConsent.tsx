import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { DICTATION_MODEL, DICTATION_MODEL_BYTES } from '../../../shared/dictation';
import {
  acceptModelDownload,
  cancelModelDownload,
  declineModelDownload,
  useDictation,
} from '../../dictation/dictation';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

const megabytes = (bytes: number) => String(Math.round(bytes / 1_000_000));

/** One row of the consent's facts: a label over its value (Dialogs & forms, grouped rows). */
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ui-row">
      <div className="ui-row-text">
        <p className="ui-row-title">{title}</p>
        <p className="ui-row-detail">{children}</p>
      </div>
    </div>
  );
}

/**
 * The speech model's one-time consent: what is downloaded (size, source at
 * its pinned revision, licence), where it is kept and what happens to the
 * audio. Nothing is fetched until Download. While it downloads the dialog
 * shows the progress with Cancel; once the model is ready it says to press
 * the mic again (no recording starts by itself).
 */
export function DictationConsent() {
  const t = useT();
  const dictation = useDictation();
  const [ready, setReady] = useState(false);
  const downloading = useRef(false);
  useEffect(() => {
    if (dictation.phase === 'downloading') {
      downloading.current = true;
      setReady(false);
    } else if (downloading.current) {
      downloading.current = false;
      if (dictation.model.state === 'ready') setReady(true);
    }
    if (dictation.phase === 'consent') setReady(false);
  }, [dictation.phase, dictation.model.state]);

  if (dictation.phase === 'consent') {
    return (
      <Dialog onClose={declineModelDownload} width={460} data-testid="dictation-consent">
        <DialogHeader title={t('dictation.consent.title')} description={t('dictation.consent.description')} />
        <DialogBody>
          <div className="ui-group">
            <Fact title={t('dictation.consent.size')}>{t('dictation.consent.sizeValue', { size: megabytes(DICTATION_MODEL_BYTES) })}</Fact>
            <Fact title={t('dictation.consent.source')}>
              <span className="ui-code">{`${DICTATION_MODEL.host} · ${DICTATION_MODEL.repo}`}</span>
              {' '}
              <span title={DICTATION_MODEL.revision}>
                {t('dictation.consent.revision', { revision: DICTATION_MODEL.revision.slice(0, 12) })}
              </span>
            </Fact>
            <Fact title={t('dictation.consent.licence')}>{DICTATION_MODEL.licence}</Fact>
            <Fact title={t('dictation.consent.storage')}>{t('dictation.consent.storageValue')}</Fact>
            <Fact title={t('dictation.consent.audio')}>{t('dictation.consent.audioValue')}</Fact>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="md" onClick={declineModelDownload} data-testid="dictation-consent-decline">
            {t('dictation.consent.notNow')}
          </Button>
          <Button variant="primary" size="md" onClick={() => void acceptModelDownload()} data-testid="dictation-consent-download">
            {t('dictation.consent.download')}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  if (dictation.phase === 'downloading') {
    const received = dictation.model.state === 'downloading' ? dictation.model.received : 0;
    const total = dictation.model.state === 'downloading' && dictation.model.total > 0 ? dictation.model.total : DICTATION_MODEL_BYTES;
    const percent = Math.min(100, Math.round((received / total) * 100));
    return (
      // No Escape and no ×: the download stops only through Cancel.
      <Dialog onClose={() => undefined} closeOnEscape={false} width={460} data-testid="dictation-downloading">
        <DialogHeader title={t('dictation.consent.downloadingTitle')} />
        <DialogBody>
          <div
            className="wmux-dictation-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('dictation.consent.downloadingTitle')}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="ui-row-detail">
            {t('dictation.consent.progress', { received: megabytes(received), total: megabytes(total) })}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" size="md" onClick={cancelModelDownload} data-testid="dictation-download-cancel">
            {t('dictation.consent.cancel')}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  if (ready && dictation.phase === 'idle') {
    return (
      <Dialog onClose={() => setReady(false)} width={420} data-testid="dictation-ready">
        <DialogHeader title={t('dictation.consent.readyTitle')} description={t('dictation.consent.readyBody')} />
        <DialogFooter>
          <Button variant="secondary" size="md" onClick={() => setReady(false)}>{t('dictation.consent.done')}</Button>
        </DialogFooter>
      </Dialog>
    );
  }
  return null;
}
