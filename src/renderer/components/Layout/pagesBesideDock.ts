import type { AppRoute } from '../../stores/slices/uiSlice';

/** Rail pages that leave the room dock in view and in reach beside them:
 *  every rail page but Bots (its conversation is the page) and Settings,
 *  which stay a full sheet and cover the dock, inert, with the rest of the
 *  Workspaces page. */
export const PAGES_BESIDE_DOCK: ReadonlySet<AppRoute> = new Set<AppRoute>(['git', 'fleet', 'schedules', 'remote']);

/** Whether the dock is on screen and usable on `route` (when it is open). */
export function dockShownOn(route: AppRoute): boolean {
  return route === 'workspaces' || PAGES_BESIDE_DOCK.has(route);
}
