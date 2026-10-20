import { useEffect, useRef, useState } from 'react';
import type { ConnectorOAuthAction, ConnectorOAuthStatus, ConnectorOAuthResult } from '../../../shared/connectorOAuth';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';

/** Independent of configuration enabled/disabled and server reachability. */
export default function ConnectorAuthorization({ id, fingerprint, onChange }: { id: string; fingerprint: string; onChange: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<ConnectorOAuthStatus>('unavailable');
  const [consent, setConsent] = useState<ConnectorOAuthResult['consent']>();
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void window.electronAPI?.connectorOAuth?.action('status', id).then((r) => { if (alive) { setStatus(r.status); setConsent(r.consent); } }).catch(() => { if (alive) setStatus('unavailable'); }); };
    refresh();
    return () => { alive = false; generation.current++; };
  }, [id, fingerprint]);
  useEffect(() => {
    if (status !== 'authorizing') return;
    let alive = true;
    const timer = setInterval(() => {
      void window.electronAPI?.connectorOAuth?.action('status', id).then((r) => { if (alive && r.status !== 'authorizing') { setStatus(r.status); setConsent(r.consent); } }).catch(() => undefined);
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [id, status]);
  const action = async (value: ConnectorOAuthAction) => {
    const attempt = ++generation.current;
    if (value === 'connect') setStatus('authorizing');
    try {
      const result = value === 'approve'
        ? await window.electronAPI.connectorOAuth.action(value, id, consent?.id)
        : await window.electronAPI.connectorOAuth.action(value, id);
      if (generation.current === attempt) { setStatus(result.status); setConsent(result.consent); onChange(); }
    } catch { if (generation.current === attempt) setStatus('failed'); }
  };
  if (status === 'unavailable') return null;
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-sub)]">
    <span role="status">{t(`connectors.oauth.${status}`)}</span>
    {status === 'confirm' && consent && <div className="w-full break-all" role="alert">
      <p>{t('connectors.oauth.consent')}</p>
      <p>{t('connectors.oauth.resource')}: {consent.resource}</p>
      <p>{t('connectors.oauth.issuer')}: {consent.issuer}</p>
      <p>{t('connectors.oauth.authorizationOrigin')}: {consent.authorizationOrigin}</p>
      <Button onClick={() => void action('approve')}>{t('connectors.oauth.approve')}</Button>
    </div>}
    {status === 'authorizing' || status === 'confirm' ? <Button onClick={() => void action('cancel')}>{t('connectors.cancel')}</Button>
      : <Button onClick={() => void action('connect')}>{t('connectors.oauth.signIn')}</Button>}
    {(status === 'authorized' || status === 'expired') && <Button onClick={() => void action('disconnect')}>{t('connectors.oauth.disconnect')}</Button>}
  </div>;
}
