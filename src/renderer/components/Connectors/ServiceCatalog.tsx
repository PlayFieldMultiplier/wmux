import { useState } from 'react';
import { CONNECTOR_SERVICES, serviceConnectorDraft } from '../../../shared/connectorServices';
import type { ConnectorDraft } from '../../../shared/botConnector';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';

export default function ServiceCatalog({ canConfigure, onConfigure }: { canConfigure: boolean; onConfigure: (draft: ConnectorDraft) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [error, setError] = useState(false);
  const entries = CONNECTOR_SERVICES.filter((entry) => (category === 'all' || entry.category === category)
    && `${entry.name} ${entry.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="flex flex-col gap-3" aria-label={t('connectors.services.title')}>
    <h2 className="text-[14px] font-semibold">{t('connectors.services.title')} ({CONNECTOR_SERVICES.length})</h2>
    <p className="text-[12px] text-[var(--text-sub)]">{t('connectors.services.hint')}</p>
    <div className="flex flex-wrap gap-2">
      <Input aria-label={t('connectors.services.search')} placeholder={t('connectors.services.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label={t('connectors.services.category')} value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-[var(--chip-radius)] bg-[var(--bg-surface)] px-2 text-[13px] text-[var(--text-main)]">
        {['all', 'communication', 'productivity', 'files', 'development', 'design', 'business'].map((key) => <option key={key} value={key}>{t(`connectors.services.category.${key}`)}</option>)}
      </select>
    </div>
    {error && <p role="alert">{t('connectors.services.openFailed')}</p>}
    {!entries.length && <p>{t('connectors.registryEmpty')}</p>}
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {entries.map((entry) => <li key={entry.id} className="rounded-[var(--chip-radius)] bg-[var(--hover-fill)] p-4">
        <h3 className="text-[14px] font-medium">{entry.name}</h3>
        <p className="my-2 text-[12px] text-[var(--text-sub)]">{t(`connectors.services.setup.${entry.setup}`)}</p>
        <p className="mb-3 break-all font-mono text-[11px] text-[var(--text-muted)]">{entry.url}</p>
        <div className="flex gap-2">
          <Button disabled={!canConfigure} onClick={() => onConfigure(serviceConnectorDraft(entry))}>{t('connectors.configure')}</Button>
          <Button onClick={() => { setError(false); void window.electronAPI?.shell?.openExternal(entry.documentation).catch(() => setError(true)); }}>{t('connectors.services.instructions')}</Button>
        </div>
      </li>)}
    </ul>
  </section>;
}
