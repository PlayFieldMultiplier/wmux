import { useEffect, useRef, useState } from 'react';
import type { ConnectorOAuthAction, ConnectorOAuthStatus, ConnectorOAuthResult } from '../../../shared/connectorOAuth';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import OAuthClientFields, { initialOAuthClient } from './OAuthClientFields';
import { parseConnectorOAuthClient } from '../../../shared/connectorOAuth';

/** Independent of configuration enabled/disabled and server reachability. */
export default function ConnectorAuthorization({ id, fingerprint, onChange, endpoint = '', autoStart = false, onAuthorized }: { id: string; fingerprint: string; onChange: () => void; endpoint?: string; autoStart?: boolean; onAuthorized?: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<ConnectorOAuthStatus>();
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [consent, setConsent] = useState<ConnectorOAuthResult['consent']>();
  const [manual, setManual] = useState(() => !!initialOAuthClient(endpoint).issuer || endpoint === 'https://mcp.hubspot.com');
  const [client, setClient] = useState(() => initialOAuthClient(endpoint));
  const generation = useRef(0);
  const started = useRef(false);
  const settledAttempt = useRef<number | undefined>(undefined);
  const reported = useRef(false);
  const authorizedCallback = useRef(onAuthorized);
  authorizedCallback.current = onAuthorized;
  useEffect(() => {
    if (status === 'authorized' && !reported.current) { reported.current = true; authorizedCallback.current?.(); }
    if (status !== 'authorized') reported.current = false;
  }, [status]);
  useEffect(() => {
    if (autoStart && !manual && (status === 'signed-out' || status === 'expired') && !started.current) {
      started.current = true;
      void action('connect');
    }
  }, [autoStart, manual, status]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void window.electronAPI?.connectorOAuth?.action('status', id).then((r) => { if (alive) { setStatus(r.status); setConsent(r.consent); } }).catch(() => { if (alive) setStatus('unavailable'); }); };
    refresh();
    return () => { alive = false; generation.current++; };
  }, [id, fingerprint, statusRefresh]);
  useEffect(() => {
    if (status !== 'authorizing') return;
    let alive = true;
    const attempt = generation.current;
    const timer = setInterval(() => {
      void window.electronAPI?.connectorOAuth?.action('status', id).then((r) => { if (alive && generation.current === attempt && settledAttempt.current !== attempt && r.status !== 'authorizing') { setStatus(r.status); setConsent(r.consent); } }).catch(() => undefined);
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [id, status]);
  const action = async (value: ConnectorOAuthAction) => {
    const supplied = value === 'connect' && manual ? parseConnectorOAuthClient(client) : undefined;
    if (value === 'connect' && manual && !supplied) { setStatus('failed'); return; }
    const attempt = value === 'approve' ? generation.current : ++generation.current;
    onChange();
    if (value === 'connect') setStatus('authorizing');
    try {
      const result = value === 'approve'
        ? await window.electronAPI.connectorOAuth.action(value, id, consent?.id)
        : supplied ? await window.electronAPI.connectorOAuth.action(value, id, undefined, supplied)
          : await window.electronAPI.connectorOAuth.action(value, id);
      if (generation.current === attempt && !(value === 'approve' && settledAttempt.current === attempt)) {
        if (value === 'connect') settledAttempt.current = attempt;
        setStatus(result.status); setConsent(result.consent);
      }
    } catch { if (generation.current === attempt) { if (value === 'connect') settledAttempt.current = attempt; setStatus('failed'); } }
    finally { if (supplied) setClient((prior) => ({ ...prior, clientSecret: '' })); }
  };
  if (status === undefined) return null;
  if (status === 'unavailable') return autoStart ? <div className="flex flex-wrap items-center gap-2">
    <p role="status">{t('connectors.quick.unavailable')}</p>
    <Button onClick={() => { started.current = false; setStatus(undefined); setStatusRefresh((value) => value + 1); }}>{t('connectors.retry')}</Button>
  </div> : null;
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-sub)]">
    {!autoStart && status !== 'authorizing' && status !== 'confirm' && <details className="w-full" open={manual}>
      <summary>{t('connectors.oauth.advanced')}</summary>
      <label><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> {t('connectors.oauth.useClient')}</label>
      {manual && <OAuthClientFields value={client} onChange={setClient} />}
    </details>}
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
