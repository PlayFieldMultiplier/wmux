import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { UI_PLUGIN_CATALOG, type UiPluginInventory } from '../../../shared/pluginManagement';
import { useT } from '../../hooks/useT';
import { refreshPlugins } from '../../plugins/usePlugins';
import { PluginGlyph } from '../../plugins/pluginGlyph';
import { useStore } from '../../stores';
import ConnectorsPage from '../Connectors/ConnectorsPage';
import { FOCUS_RING } from '../focusRing';
import { IconCheck, IconPlug, IconSearch, Icon } from '../icons';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import {
  PLUGIN_STATE_LABEL_KEYS, PLUGIN_STATE_NOTE_KEYS, pluginActions, pluginPermissionLines, pluginSections,
  type PluginAction, type PluginRow,
} from './pluginsModel';

/** The selection id of the Connectors row (the connectors route selects it). */
export const CONNECTORS_ROW = 'connectors';

type T = ReturnType<typeof useT>;

function rowName(row: PluginRow, t: T): string {
  return row.catalog ? t(row.catalog.titleKey) : row.installed?.contributes.railPage?.title ?? row.id;
}
function rowTagline(row: PluginRow, t: T): string {
  return row.catalog ? t(row.catalog.taglineKey) : row.installed?.description ?? '';
}

/**
 * The Plugins rail page (owner-approved 2026-10-21): a mantle list column
 * (Signature, Catalog, Installed by hand, Connectors) beside one detail.
 * Installing grants nothing; the page only ever asks main to review a
 * bundle's permissions, through the same approval dialog as before.
 */
export default function PluginsPage() {
  const t = useT();
  const selection = useStore((s) => s.pluginsSelection);
  const [query, setQuery] = useState('');
  const [inventory, setInventory] = useState<UiPluginInventory>({ plugins: [], failures: [] });
  const [loading, setLoading] = useState(true);
  // Until one list has arrived nothing is known to be installed, so Install
  // waits (main would refuse a bundle that is already there).
  const [known, setKnown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.pluginManagement.list();
      if (epoch === generation.current) { setInventory(result); setKnown(true); setFailed(false); }
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

  const needle = query.trim().toLowerCase();
  const matchesText = useCallback((...parts: string[]) => !needle || parts.join(' ').toLowerCase().includes(needle), [needle]);
  const sections = useMemo(
    () => pluginSections(UI_PLUGIN_CATALOG, inventory.plugins, (row) => matchesText(rowName(row, t), rowTagline(row, t), row.id)),
    [inventory.plugins, matchesText, t],
  );
  const connectorsShown = matchesText(t('plugins.page.connectorsName'), t('plugins.page.connectorsTagline'), t('connectors.title'));
  const rows = [...sections.signature, ...sections.catalog, ...sections.installed];
  // The selection survives the search: an entry filtered out of the list
  // stays open in the detail until another row is picked.
  const allRows = useMemo(() => {
    const all = pluginSections(UI_PLUGIN_CATALOG, inventory.plugins);
    return [...all.signature, ...all.catalog, ...all.installed];
  }, [inventory.plugins]);
  const connectorsSelected = selection === CONNECTORS_ROW;
  const selected = connectorsSelected ? null : allRows.find((row) => row.id === selection) ?? allRows[0] ?? null;
  const select = (id: string) => { setRemoving(null); useStore.getState().setPluginsSelection(id); };

  // Arrow keys walk the rows and select as they go, like the sidebar.
  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-plugin-row]')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
    buttons[next]?.click();
  };

  const renderRow = (row: PluginRow) => {
    const current = !connectorsSelected && selected?.id === row.id;
    const stateKey = PLUGIN_STATE_LABEL_KEYS[row.state];
    return <button key={row.id} type="button" data-plugin-row={row.id} aria-current={current ? 'true' : undefined}
      className={`wmux-plugins-row ${FOCUS_RING}`} onClick={() => select(row.id)}>
      <span className="wmux-plugins-tile" data-signature={row.catalog?.signature ? 'true' : undefined} aria-hidden="true"><PluginGlyph glyph={row.catalog?.glyph} /></span>
      <span className="wmux-plugins-row-text">
        <span className="wmux-plugins-row-name">{rowName(row, t)}</span>
        <span className="wmux-plugins-row-tagline">{rowTagline(row, t)}</span>
      </span>
      {stateKey && <span className="wmux-plugins-row-state">{t(stateKey)}</span>}
    </button>;
  };
  const nothingShown = rows.length === 0 && !connectorsShown;

  return <div className="wmux-plugins" data-plugins-page>
    <section className="wmux-plugins-list" aria-label={t('plugins.page.list')} onKeyDown={onListKeyDown}>
      <div className="wmux-plugins-head"><h1 className="wmux-plugins-title">{t('plugins.settings.title')}</h1></div>
      <label className="wmux-plugins-search">
        <IconSearch size={14} />
        <input type="search" value={query} placeholder={t('plugins.page.search')} aria-label={t('plugins.page.search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }} />
      </label>
      {sections.signature.length > 0 && <>
        <h2 className="wmux-plugins-heading" data-plugins-section="signature">{t('plugins.page.signature')}</h2>
        {sections.signature.map(renderRow)}
      </>}
      {sections.catalog.length > 0 && <>
        <h2 className="wmux-plugins-heading" data-plugins-section="catalog">{t('plugins.page.catalog')}</h2>
        {sections.catalog.map(renderRow)}
      </>}
      {sections.installed.length > 0 && <>
        <h2 className="wmux-plugins-heading" data-plugins-section="installed" data-installed-section>{t('plugins.settings.installed')}</h2>
        {sections.installed.map(renderRow)}
      </>}
      {connectorsShown && <>
        <h2 className="wmux-plugins-heading" data-plugins-section="connectors">{t('connectors.title')}</h2>
        <button type="button" data-plugin-row={CONNECTORS_ROW} aria-current={connectorsSelected ? 'true' : undefined}
          className={`wmux-plugins-row ${FOCUS_RING}`} onClick={() => select(CONNECTORS_ROW)}>
          <span className="wmux-plugins-tile" aria-hidden="true"><IconPlug size={16} /></span>
          <span className="wmux-plugins-row-text">
            <span className="wmux-plugins-row-name">{t('plugins.page.connectorsName')}</span>
            <span className="wmux-plugins-row-tagline">{t('plugins.page.connectorsTagline')}</span>
          </span>
        </button>
      </>}
      {nothingShown && <p className="wmux-plugins-muted px-2">{t('plugins.page.noResults')}</p>}
      {inventory.failures.map((failure) => <p key={failure.name} role="status" className="wmux-plugins-muted px-2 pt-3">{t('plugins.settings.loadFailed', { name: failure.name })}</p>)}
    </section>
    {connectorsSelected
      ? <div className="wmux-plugins-connectors"><ConnectorsPage /></div>
      : <section className="wmux-plugins-detail" aria-label={t('plugins.page.detail')}>
        {failed && <div role="alert" className="wmux-plugins-alert"><span>{t('plugins.settings.failed')}</span><Button onClick={() => void reload()}>{t('connectors.retry')}</Button></div>}
        {selected
          ? <PluginDetail row={selected} busy={busy || loading} known={known} removing={removing === selected.id}
            onRemoving={(on) => setRemoving(on ? selected.id : null)} mutate={mutate} />
          : loading && <p role="status" className="wmux-plugins-muted">{t('connectors.loading')}</p>}
      </section>}
  </div>;
}

function PluginDetail({ row, busy, known, removing, onRemoving, mutate }: {
  row: PluginRow; busy: boolean; known: boolean; removing: boolean;
  onRemoving: (on: boolean) => void;
  mutate: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT();
  const plugin = row.installed;
  const entry = row.catalog;
  const credit = entry
    ? [entry.publisher, entry.license, plugin?.version || entry.version].join(' · ')
    : [row.id, plugin?.version].filter(Boolean).join(' · ');
  const description = entry ? t(entry.hintKey) : plugin?.description;
  const capabilities = plugin?.capabilities ?? entry?.capabilities ?? [];
  const { primary, secondary } = pluginActions(row);
  const run: Record<PluginAction, () => void> = {
    install: () => void act(() => window.electronAPI.pluginManagement.install(row.id)),
    readme: () => { if (entry) void window.electronAPI.shell?.openExternal?.(entry.readme)?.catch?.(() => undefined); },
    approve: () => void act(() => window.electronAPI.plugins.requestApproval(row.id)),
    open: () => useStore.getState().setAppRoute(`plugin:${row.id}`),
    enable: () => void act(() => window.electronAPI.pluginManagement.setEnabled(row.id, true)),
    disable: () => void act(() => window.electronAPI.pluginManagement.setEnabled(row.id, false)),
    uninstall: () => onRemoving(true),
  };
  const labels: Record<PluginAction, string> = {
    install: t('plugins.settings.install'), readme: t('plugins.page.readme'), approve: t('plugins.page.approve'),
    open: t('plugins.settings.open'), enable: t('connectors.enable'), disable: t('connectors.disable'), uninstall: t('plugins.settings.uninstall'),
  };
  // Turning a broken bundle on or off is refused by main; say so by disabling.
  const blocked = (action: PluginAction) => busy || (action === 'install' && !known)
    || ((action === 'enable' || action === 'disable') && !!plugin?.invalid);
  // An action that swaps the buttons (Install, Review, Enable, Uninstall)
  // takes the focused one away: hand focus to the new primary, not the body.
  const actionsRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (busy || !refocus.current) return;
    if (document.activeElement && document.activeElement !== document.body) { refocus.current = false; return; }
    const next = actionsRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    if (next) { next.focus(); refocus.current = false; }
  }, [busy, row.state, removing]);
  const act = (action: () => Promise<unknown>) => { refocus.current = true; return mutate(action); };
  return <div className="wmux-plugins-detail-body" data-plugin-detail={row.id}>
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="wmux-plugins-detail-title">{rowName(row, t)}</h2>
        {entry?.signature && <Badge data-plugin-signature-chip>{t('plugins.page.signature')}</Badge>}
      </div>
      <span className="text-[12px] text-[var(--text-sub)]">{credit}</span>
    </div>
    {description && <p className="wmux-plugins-description">{description}</p>}
    <div className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-[var(--text-main)]">{t('plugins.page.whatItCanDo')}</h3>
      <ul className="flex flex-col gap-2">
        {pluginPermissionLines(capabilities).map((line) => <li key={`${line.capability}:${line.granted}`} className="wmux-plugins-perm" data-granted={line.granted ? 'true' : 'false'}>
          <span className="wmux-plugins-perm-mark" aria-hidden="true">{line.granted ? <IconCheck size={14} /> : <Icon size={14}><circle cx="7" cy="7" r="4.7" /><path d="M3.8 10.2 10.2 3.8" /></Icon>}</span>
          <span className="min-w-0">{line.labelKey ? t(line.labelKey) : line.capability}{line.labelKey && <span className="wmux-plugins-perm-cap">{line.capability}</span>}</span>
        </li>)}
      </ul>
    </div>
    {removing
      ? <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[var(--text-sub)]">{t('plugins.settings.removeHint')}</span>
        <Button autoFocus disabled={busy} onClick={() => onRemoving(false)}>{t('connectors.cancel')}</Button>
        <Button variant="danger" disabled={busy} onClick={() => void act(() => window.electronAPI.pluginManagement.remove(row.id))}>{t('plugins.settings.uninstall')}</Button>
      </div>
      : <div ref={actionsRef} className="flex flex-wrap items-center gap-2">
        {primary && <Button variant="primary" disabled={blocked(primary)} onClick={run[primary]}>{labels[primary]}</Button>}
        {secondary.map((action) => <Button key={action} disabled={blocked(action)} onClick={run[action]}>{labels[action]}</Button>)}
      </div>}
    <p className="wmux-plugins-muted">{t(PLUGIN_STATE_NOTE_KEYS[row.state])}</p>
    {plugin && !plugin.managed && <p className="wmux-plugins-muted">{t('plugins.settings.manual')}</p>}
  </div>;
}
