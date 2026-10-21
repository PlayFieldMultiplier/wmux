import PluginRailPage from '../../plugins/PluginRailPage';
import PluginsPage from '../Plugins/PluginsPage';
import { lazy, Suspense, useEffect } from 'react';
import { useStore } from '../../stores';
import { ErrorBoundary } from '../ErrorBoundary';
import FleetView from '../FleetView/FleetView';
import SchedulesView from '../Schedules/SchedulesView';
import RemotePage from '../Remote/RemotePage';
import GitPage from '../Git/GitPage';
import BotsPage from '../Bots/BotsPage';
import { useT } from '../../hooks/useT';
import { selectSelectedRemotePcName } from '../Git/thisComputerOnly';

const SettingsPanel = lazy(() => import('../Settings/SettingsPanel'));

/** Rail pages that show this computer only (Remote is about the others). */
const THIS_COMPUTER_PAGES: ReadonlySet<string> = new Set(['bots', 'fleet', 'schedules', 'git', 'plugins']);

/**
 * The muted line a rail page shows while another computer is selected in the
 * PC rail, or null. Its data stays this computer's either way. A computer the
 * roster has not named yet gets no line rather than an empty name. Pure.
 */
export function thisComputerOnlyLine(route: string, remotePcName: string | null, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (!remotePcName || (!THIS_COMPUTER_PAGES.has(route) && !route.startsWith('plugin:'))) return null;
  return t('pcRail.thisComputerOnly', { name: remotePcName });
}

/**
 * The page the rail has swapped into the sheet, drawn over the whole
 * Workspaces page (sidebar, panes, file tree) that stays mounted and inert
 * underneath — so PTYs, scrollback, the WebGL atlas and IME state survive
 * the round trip and no terminal is ever resized. Settings also stays mounted
 * while inspect mode is picking colours, when it shrinks to its floating bar.
 */
export default function RailPage() {
  const t = useT();
  const route = useStore((s) => s.appRoute);
  const remotePcName = useStore(selectSelectedRemotePcName);
  const inspectModeActive = useStore((s) => s.inspectModeActive);
  // Keys must not reach a terminal hidden under the page: drop focus left
  // behind in the (now inert) Workspaces page. The page then takes focus.
  useEffect(() => {
    if (route === 'workspaces' || inspectModeActive) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.closest('[data-workspaces-page]')) active.blur();
  }, [route, inspectModeActive]);
  if (route === 'settings' || inspectModeActive) {
    return (
      <ErrorBoundary name="SettingsPanel">
        <Suspense fallback={null}><SettingsPanel /></Suspense>
      </ErrorBoundary>
    );
  }
  if (route === 'workspaces') return null;
  const scopeLine = thisComputerOnlyLine(route, remotePcName, t);
  return (
    <div className="wmux-page" data-rail-page={route}>
      {/* Inset to the page's own text edge (Git pads 28px, the others 20px). */}
      {scopeLine && (
        <p className={`shrink-0 truncate pt-2 text-[12px] text-[var(--text-muted)] ${route === 'git' ? 'px-7' : 'px-5'}`} data-this-computer-only title={scopeLine}>{scopeLine}</p>
      )}
      {/* The page's own box: Schedules fills it absolutely, the others flex. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {route === 'bots' && <ErrorBoundary name="BotsPage"><BotsPage /></ErrorBoundary>}
        {route === 'fleet' && <ErrorBoundary name="FleetView"><FleetView /></ErrorBoundary>}
        {route === 'schedules' && <ErrorBoundary name="SchedulesView"><SchedulesView /></ErrorBoundary>}
        {route === 'remote' && <ErrorBoundary name="RemotePage"><RemotePage /></ErrorBoundary>}
        {route.startsWith('plugin:') && <ErrorBoundary key={route} name="PluginRailPage"><PluginRailPage name={route.slice(7)} /></ErrorBoundary>}
        {route === 'plugins' && <ErrorBoundary name="PluginsPage"><PluginsPage /></ErrorBoundary>}
        {route === 'git' && <ErrorBoundary name="GitPage"><GitPage /></ErrorBoundary>}
      </div>
    </div>
  );
}
