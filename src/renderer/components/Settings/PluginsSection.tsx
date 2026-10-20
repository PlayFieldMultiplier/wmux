import { useCallback, useEffect, useRef, useState } from 'react';
import { UI_PLUGIN_CATALOG, type UiPluginInventory } from '../../../shared/pluginManagement';
import { useT } from '../../hooks/useT';
import { refreshPlugins } from '../../plugins/usePlugins';
import { useStore } from '../../stores';
import ConnectorsPage from '../Connectors/ConnectorsPage';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import { SettingsSection, useOwnedDialog } from './SettingsLayout';

export default function PluginsSection() {
  const t = useT();
  const [view, setView] = useState<'mine' | 'discover'>('mine');
  const [inventory, setInventory] = useState<UiPluginInventory>({ plugins: [], failures: [] });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useOwnedDialog(reviewing);
  const reload = useCallback(async () => {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.pluginManagement.list();
      if (epoch === generation.current) { setInventory(result); setFailed(false); }
    } catch { if (epoch === generation.current) setFailed(true); }
    finally { if (epoch === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const unsubscribe = window.electronAPI.pluginManagement.onChanged(() => { void reload(); });
    return () => { generation.current++; unsubscribe(); };
  }, [reload]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { await action(); setRemoving(null); await Promise.all([reload(), refreshPlugins()]); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="flex flex-col gap-8" data-setting-id="plugins">
    <div className="flex flex-col items-start gap-3">
      <p className="text-[12px] text-[var(--text-sub)]">{t('plugins.settings.description')}</p>
      <SegmentedControl value={view} onValueChange={setView} ariaLabel={t('plugins.settings.views')} options={[
        { value: 'mine', label: t('plugins.settings.installed') }, { value: 'discover', label: t('connectors.discover') },
      ]} />
    </div>
    <SettingsSection title={t('plugins.settings.ui')} description={t('plugins.settings.uiHint')}>
      {failed && <div role="alert" className="flex items-center gap-3 px-3.5 py-3 text-[13px] text-[var(--text-sub)]"><span>{t('plugins.settings.failed')}</span><Button onClick={() => void reload()}>{t('connectors.retry')}</Button></div>}
      {loading && <p role="status" className="px-3.5 py-3 text-[12px] text-[var(--text-sub)]">{t('connectors.loading')}</p>}
      {view === 'mine' && !loading && inventory.plugins.length === 0 && <p className="px-3.5 py-3 text-[12px] text-[var(--text-sub)]">{t('plugins.settings.empty')}</p>}
      {view === 'mine' && inventory.plugins.map((plugin) => <div key={plugin.name} className="px-3.5 py-3" data-ui-plugin={plugin.name}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[14px]">{plugin.contributes.railPage?.title ?? plugin.name}</span>
          <Badge>{t(!plugin.enabled ? 'connectors.disabled' : plugin.trustStatus === 'trusted' ? 'plugins.settings.ready' : 'plugins.settings.notApproved')}</Badge>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-sub)]">{plugin.description}</p>
        <p className="mt-1 text-[11px] text-[var(--text-sub)]">{plugin.name} · {plugin.version}{plugin.managed ? ' · wmux · MIT' : ''}</p>
        <details className="mt-2 text-[12px] text-[var(--text-sub)]"><summary>{t('plugins.settings.permissions')}</summary><ul className="mt-1 list-inside list-disc">{plugin.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul></details>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {plugin.enabled && plugin.trustStatus !== 'trusted' && <Button disabled={busy || loading} onClick={() => void mutate(async () => {
            setReviewing(true);
            try { await window.electronAPI.plugins.requestApproval(plugin.name); }
            finally { setReviewing(false); }
          })}>{t('plugins.page.approve')}</Button>}
          {plugin.enabled && plugin.trustStatus === 'trusted' && plugin.contributes.railPage && <Button disabled={busy || loading} onClick={() => useStore.getState().setAppRoute(`plugin:${plugin.name}`)}>{t('plugins.settings.open')}</Button>}
          <Button disabled={busy || loading || plugin.invalid} onClick={() => void mutate(() => window.electronAPI.pluginManagement.setEnabled(plugin.name, !plugin.enabled))}>{t(plugin.enabled ? 'connectors.disable' : 'connectors.enable')}</Button>
          {plugin.managed && (removing !== plugin.name ? <Button disabled={busy || loading} onClick={() => setRemoving(plugin.name)}>{t('plugins.settings.uninstall')}</Button> : <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-[var(--text-sub)]">{t('plugins.settings.removeHint')}</span>
            <Button autoFocus disabled={busy} onClick={() => setRemoving(null)}>{t('connectors.cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void mutate(() => window.electronAPI.pluginManagement.remove(plugin.name))}>{t('plugins.settings.uninstall')}</Button>
          </div>)}
        </div>
        {!plugin.managed && <p className="mt-2 text-[12px] text-[var(--text-sub)]">{t('plugins.settings.manual')}</p>}
      </div>)}
      {view === 'discover' && UI_PLUGIN_CATALOG.map((entry) => <div key={entry.id} className="px-3.5 py-3">
        <div className="flex items-center justify-between gap-3"><span className="text-[14px]">{t('plugins.settings.agentStatus')}</span><Button disabled={busy || loading || inventory.plugins.some((plugin) => plugin.name === entry.id)} onClick={() => void mutate(async () => { await window.electronAPI.pluginManagement.install(entry.id); setView('mine'); })}>{t(inventory.plugins.some((plugin) => plugin.name === entry.id) ? 'plugins.settings.installed' : 'plugins.settings.install')}</Button></div>
        <p className="mt-1 text-[12px] text-[var(--text-sub)]">{t('plugins.settings.agentStatusHint')}</p>
        <p className="mt-1 text-[11px] text-[var(--text-sub)]">{entry.publisher} · {entry.license} · {entry.version}</p>
      </div>)}
      {inventory.failures.map((failure) => <p key={failure.name} role="status" className="px-3.5 py-3 text-[12px] text-[var(--text-sub)]">{t('plugins.settings.loadFailed', { name: failure.name })}</p>)}
    </SettingsSection>
    <ConnectorsPage embedded selectedView={view} />
  </div>;
}
