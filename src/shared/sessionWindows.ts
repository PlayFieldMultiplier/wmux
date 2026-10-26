// Multiple windows (roadmap P2-1): which window shows which workspaces.
//
// session.json is hand-editable and may have been saved by an older version
// that drops `windows`, so the field is untrusted. This resolver is the one
// place that turns it into an assignment where every workspace in
// `session.workspaces` belongs to exactly one window:
//   - a window entry without a usable id, or with an id seen before, is dropped;
//   - a workspace id that is not in `session.workspaces` is dropped;
//   - a workspace listed by two windows stays with the first;
//   - a workspace no window lists goes to the primary window (windows[0]);
//   - a window left with no workspaces is dropped (the primary is kept);
//   - no usable window at all = one primary window with every workspace.

import type { SessionData, SessionWindow } from './types';

/** Window id used when the session has no usable windows (single-window and
 *  pre-P2-1 sessions). */
export const PRIMARY_WINDOW_ID = 'primary';

export interface ResolvedSessionWindow {
  id: string;
  workspaceIds: string[];
  /** One of workspaceIds, or undefined when the window has none. */
  activeWorkspaceId: string | undefined;
}

export function resolveSessionWindows(
  session: Pick<SessionData, 'workspaces' | 'activeWorkspaceId' | 'windows'>,
): ResolvedSessionWindow[] {
  const known = new Set(session.workspaces.map((w) => w.id));
  const placed = new Set<string>();
  const seenIds = new Set<string>();
  const out: ResolvedSessionWindow[] = [];

  const raw: unknown = session.windows;
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const w = entry as Partial<SessionWindow>;
    if (typeof w.id !== 'string' || w.id === '' || seenIds.has(w.id)) continue;
    seenIds.add(w.id);
    const ids: string[] = [];
    for (const id of Array.isArray(w.workspaceIds) ? w.workspaceIds : []) {
      if (typeof id !== 'string' || !known.has(id) || placed.has(id)) continue;
      placed.add(id);
      ids.push(id);
    }
    out.push({ id: w.id, workspaceIds: ids, activeWorkspaceId: typeof w.activeWorkspaceId === 'string' ? w.activeWorkspaceId : undefined });
  }

  if (out.length === 0) out.push({ id: PRIMARY_WINDOW_ID, workspaceIds: [], activeWorkspaceId: session.activeWorkspaceId });
  const primary = out[0];
  for (const ws of session.workspaces) {
    if (!placed.has(ws.id)) {
      placed.add(ws.id);
      primary.workspaceIds.push(ws.id);
    }
  }

  const kept = out.filter((w, i) => i === 0 || w.workspaceIds.length > 0);
  for (const w of kept) {
    if (w.activeWorkspaceId === undefined || !w.workspaceIds.includes(w.activeWorkspaceId)) {
      w.activeWorkspaceId = w.workspaceIds[0];
    }
  }
  return kept;
}
