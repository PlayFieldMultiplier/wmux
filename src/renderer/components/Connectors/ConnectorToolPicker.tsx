import { useState } from 'react';
import { CONNECTOR_LIMITS, CONNECTOR_TOOL_RE, type ConnectorTools } from '../../../shared/botConnector';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';

export default function ConnectorToolPicker({ names, policy, disabled, onReview }: { names: string[]; policy: ConnectorTools; disabled: boolean; onReview: (tools: ConnectorTools) => void }) {
  const t = useT();
  const tools = [...new Set(names)].filter((name) => CONNECTOR_TOOL_RE.test(name));
  const [selected, setSelected] = useState<string[]>(() => tools.filter((name) => policy.mode === 'all' ? !policy.blocked.includes(name) : policy.allowed.includes(name)));
  return <details className="w-full text-[12px] text-[var(--text-sub)]">
    <summary>{t('connectors.tools.title')} ({tools.length})</summary>
    <p className="my-2">{t('connectors.tools.hint')}</p>
    <div className="max-h-64 overflow-y-auto">
      {tools.map((name) => <label key={name} className="flex gap-2 py-1 font-mono">
        <input type="checkbox" checked={selected.includes(name)} disabled={disabled || (!selected.includes(name) && selected.length >= CONNECTOR_LIMITS.TOOLS)}
          onChange={(e) => setSelected((prior) => e.target.checked ? [...prior, name] : prior.filter((n) => n !== name))} />{name}
      </label>)}
    </div>
    <Button disabled={disabled || selected.length > CONNECTOR_LIMITS.TOOLS} onClick={() => onReview({ mode: 'listed', allowed: selected })}>{t('connectors.tools.review')}</Button>
  </details>;
}
