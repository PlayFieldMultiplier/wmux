import { useEffect, useRef, useState } from 'react';
import type { ConnectorService } from '../../../shared/connectorServices';
import { serviceConnectorDraft } from '../../../shared/connectorServices';
import type { ConnectorView } from '../../../shared/botConnector';
import type { ConnectorCheckResult } from '../../../shared/connectorCheck';
import type { BotConnectorPort } from '../Room/botConnectors';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import ConnectorAuthorization from './ConnectorAuthorization';

/** Explicit catalog click starts sign-in. Account connection grants no tool or bot access. */
export default function ServiceConnect({ service, port, disabled }: { service: ConnectorService; port: BotConnectorPort; disabled: boolean }) {
  const t = useT();
  const [connection, setConnection] = useState<ConnectorView>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reviewExisting, setReviewExisting] = useState(false);
  const [check, setCheck] = useState<ConnectorCheckResult | 'checking'>();
  const pending = useRef(false);
  const alive = useRef(true);
  const checkGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const connect = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try {
      const listed = await port.list();
      if (!listed.ok || listed.cannotStore) throw new Error('Unavailable');
      const existing = listed.connectors.find((item) => item.transport === 'http' && item.remote?.url === service.url);
      if (!alive.current) return;
      if (existing) {
        if (!existing.enabled || existing.secrets.length || Object.keys(existing.remote?.headers ?? {}).some((key) => /authorization|cookie/i.test(key))) { setReviewExisting(true); return; }
        setConnection(existing);
      }
      else {
        const names = new Set(listed.connectors.map((item) => item.name));
        let name = service.id;
        for (let suffix = 2; names.has(name); suffix++) name = `${service.id.slice(0, 24)}-${suffix}`;
        const saved = await port.save({ connector: { ...serviceConnectorDraft(service), name, enabled: true } });
        if (!saved.ok) throw new Error('Save failed');
        if (alive.current) setConnection(saved.connector);
      }
    } catch { if (alive.current) setFailed(true); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const verify = async () => {
    if (!connection || !alive.current) return;
    const generation = ++checkGeneration.current;
    setCheck('checking');
    try {
      const result = await window.electronAPI.connectorChecks.check(connection.id);
      if (alive.current && generation === checkGeneration.current) setCheck(result);
    } catch { if (alive.current && generation === checkGeneration.current) setCheck({ status: 'failed' }); }
  };
  return <div className="mt-3 flex flex-col items-start gap-2">
    {!connection && !reviewExisting && <Button disabled={disabled || busy} onClick={() => void connect()}>{t(busy ? 'connectors.quick.preparing' : 'connectors.quick.connect')}</Button>}
    {reviewExisting && <p role="status">{t('connectors.quick.reviewExisting')}</p>}
    {failed && <p role="alert">{t('connectors.quick.failed')}</p>}
    {connection && <ConnectorAuthorization id={connection.id} endpoint={service.url} fingerprint={JSON.stringify(connection)} autoStart onAuthorized={() => void verify()} onChange={() => { checkGeneration.current++; setCheck(undefined); }} />}
    {check && <p role="status">{t(check === 'checking' ? 'connectors.checking' : check.status === 'ready' ? 'connectors.quick.ready' : 'connectors.quick.checkFailed')}</p>}
    {check && check !== 'checking' && check.status !== 'ready' && <Button onClick={() => void verify()}>{t('connectors.retry')}</Button>}
  </div>;
}
