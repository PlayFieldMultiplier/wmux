import { useEffect, useState } from 'react';
import type { ConnectorTerminalAccess } from '../../../shared/connectorAccess';
import type { ConnectorTerminalContext } from '../../../shared/connectorTerminal';
import Field from '../ui/Field';
import Select from '../ui/Select';
import Checkbox from '../ui/Checkbox';
import { useT } from '../../hooks/useT';

export default function ConnectorAccess({ value, onChange }: { value: ConnectorTerminalAccess; onChange: (value: ConnectorTerminalAccess) => void }) {
  const t = useT();
  const [context, setContext] = useState<ConnectorTerminalContext | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => window.electronAPI?.connectorTerminal?.targets()).then((c) => { if (alive) setContext(c ?? null); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const choices = (field: 'workspaceIds' | 'paneIds' | 'excludedWorkspaceIds' | 'excludedPaneIds', rows: Array<{ id: string; name: string }>) => {
    const all = [...rows, ...value[field].filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ id, name: `${t('connectors.access.unavailable')}: ${id}` }))];
    return <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">{all.map((r) => <label key={r.id} className="flex items-center gap-2 text-[13px]">
      <Checkbox checked={value[field].includes(r.id)} onCheckedChange={(checked) => onChange({ ...value, [field]: checked ? [...value[field], r.id] : value[field].filter((id) => id !== r.id) })} />{r.name}
    </label>)}</div>;
  };
  const workspaces = context?.workspaces ?? [];
  const panes = (context?.panes ?? []).map((p) => ({ id: p.id, name: `${workspaces.find((w) => w.id === p.workspaceId)?.name ?? p.workspaceId} · ${(p.name ?? p.id.slice(-8))}` }));
  return <div className="flex flex-col gap-3">
    <Field label={t('connectors.access.title')} layout="stacked">
      <Select data-testid="connector-terminal-access" value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as ConnectorTerminalAccess['mode'] })}>
        {(['none', 'all', 'workspaces', 'panes'] as const).map((mode) => <option key={mode} value={mode}>{t(`connectors.access.${mode}`)}</option>)}
      </Select>
    </Field>
    <p className="text-[11px] text-[var(--text-sub)]">{t('connectors.access.hint')}</p>
    {value.mode === 'workspaces' && choices('workspaceIds', workspaces)}
    {value.mode === 'panes' && choices('paneIds', panes)}
    {value.mode !== 'none' && <>
      <Field label={t('connectors.access.excludeWorkspaces')} layout="stacked">{choices('excludedWorkspaceIds', workspaces)}</Field>
      <Field label={t('connectors.access.excludePanes')} layout="stacked">{choices('excludedPaneIds', panes)}</Field>
    </>}
  </div>;
}
