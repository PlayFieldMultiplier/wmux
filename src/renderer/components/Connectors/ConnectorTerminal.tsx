import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';

export default function ConnectorTerminal({ id, enabled }: { id: string; enabled: boolean }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const copy = async (agent: 'claude' | 'codex') => {
    setState('busy');
    try {
      const result = await window.electronAPI.connectorTerminal.launchCommand(id, agent);
      if (!result.ok) throw new Error('Unavailable');
      if (!alive.current) return;
      if (!window.clipboardAPI.writeEphemeral) throw new Error('Clipboard unavailable');
      await window.clipboardAPI.writeEphemeral(result.command, 60_000);
      if (alive.current) setState('copied');
    } catch { if (alive.current) setState('failed'); }
  };
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-sub)]">
    <Button disabled={!enabled || state === 'busy'} onClick={() => void copy('claude')}>{t('connectors.terminal.claude')}</Button>
    <Button disabled={!enabled || state === 'busy'} onClick={() => void copy('codex')}>{t('connectors.terminal.codex')}</Button>
    <span role="status">{t(`connectors.terminal.${state === 'copied' || state === 'failed' ? state : 'hint'}`)}</span>
  </div>;
}
