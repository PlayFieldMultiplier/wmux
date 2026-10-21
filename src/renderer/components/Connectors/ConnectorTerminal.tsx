import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Select from '../ui/Select';
import type { ConnectorTerminalContext } from '../../../shared/connectorTerminal';

export default function ConnectorTerminal({ id, enabled }: { id: string; enabled: boolean }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'started' | 'failed'>('idle');
  const [context, setContext] = useState<ConnectorTerminalContext | null>(null);
  const [ptyId, setPtyId] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { void Promise.resolve().then(() => window.electronAPI.connectorTerminal.targets()).then((c) => { if (alive.current) setContext(c); }).catch(() => undefined); }, []);
  const launch = async (agent: 'claude' | 'codex') => {
    setState('busy');
    try {
      const result = await window.electronAPI.connectorTerminal.launch(id, agent, ptyId);
      if (!result.ok) throw new Error('Unavailable');
      if (!alive.current) return;
      if (alive.current) setState('started');
    } catch { if (alive.current) setState('failed'); }
  };
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-sub)]">
    <Select aria-label={t('connectors.access.target')} value={ptyId} onChange={(e) => setPtyId(e.target.value)} disabled={state === 'busy'}>
      <option value="">{t('connectors.access.target')}</option>
      {context?.panes.flatMap((p) => p.ptyIds.map((id) => <option key={id} value={id}>{context.workspaces.find((w) => w.id === p.workspaceId)?.name} · {(p.name ?? p.id.slice(-8))} · {id.slice(-6)}</option>))}
    </Select>
    <Button disabled={!enabled || !ptyId || state === 'busy'} onClick={() => void launch('claude')}>{t('connectors.access.claude')}</Button>
    <Button disabled={!enabled || !ptyId || state === 'busy'} onClick={() => void launch('codex')}>{t('connectors.access.codex')}</Button>
    <span role="status">{t(state === 'started' ? 'connectors.access.started' : state === 'failed' ? 'connectors.access.failed' : 'connectors.access.hint')}</span>
  </div>;
}
