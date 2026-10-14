import type { SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import { hookFingerprint } from '../../inventory/helpers';
import { SurfacesStore } from '../../safeWrite';
import { deepEqual } from '../../safeWrite/deepEqual';
import type { ResolvedChange } from '../types';
import type { ClaudeHookHandler, ClaudeMatcherGroup, ClaudeRemovedHookDefinition } from './types';

const AMBIGUOUS_HOOK = 'More than one hook matches; edit this hook in the settings file by hand.';

/** A matcher group's fields other than its handlers. */
function groupMetaOf(group: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(group)) {
    if (k !== 'hooks') meta[k] = v;
  }
  return meta;
}

function isMatcherGroup(entry: unknown): entry is ClaudeMatcherGroup {
  return typeof entry === 'object' && entry !== null && Array.isArray((entry as ClaudeMatcherGroup).hooks);
}

function handlerMatchesItem(
  h: ClaudeHookHandler,
  item: SurfaceItem,
  event: string,
  groupMeta: Record<string, unknown> | undefined,
): boolean {
  // Unnamed handlers all share the name `<event>-<type>`, so a name alone can point at the wrong one.
  if (item.hookFingerprint) return hookFingerprint(event, groupMeta, h) === item.hookFingerprint;
  const hType = typeof h.type === 'string' ? h.type : 'command';
  const hName = (typeof h.name === 'string' && h.name) || `${event}-${hType}`;
  return hName === item.name;
}

interface HookDisableMatch {
  change: ResolvedChange;
  event: string;
  groupIdx: number;
  handlerIdx: number | null;
  handler: ClaudeHookHandler;
  groupMeta?: Record<string, unknown>;
}

export function applyHookChangesToRoot(
  root: Record<string, unknown>,
  changes: ResolvedChange[],
  targetPath: string,
  store: SurfacesStore,
): void {
  const disableChanges = changes.filter((c) => !c.enabled);
  if (disableChanges.length > 0) {
    removeHooks(root, disableChanges, targetPath, store);
  }
  for (const change of changes.filter((c) => c.enabled)) {
    restoreHook(root, change, store);
  }
}

/**
 * Every hook is found and saved in the store before the root changes, so a hook that cannot be pinned
 * down leaves both the settings and the store as they were.
 */
function removeHooks(
  root: Record<string, unknown>,
  changes: ResolvedChange[],
  targetPath: string,
  store: SurfacesStore,
): void {
  const hooksObj = root.hooks as Record<string, unknown> | undefined;
  if (!hooksObj || typeof hooksObj !== 'object') {
    throw new Error('Hook not found: hooks configuration missing');
  }

  const matches = changes.map((change) => findHookToRemove(hooksObj, change));
  saveRemovedHooks(matches, targetPath, store);

  const byEvent = new Map<string, HookDisableMatch[]>();
  for (const m of matches) {
    byEvent.set(m.event, [...(byEvent.get(m.event) ?? []), m]);
  }
  for (const [event, eventMatches] of byEvent.entries()) {
    const eventList = hooksObj[event] as unknown[];
    removeMatches(eventList, eventMatches);
    if (eventList.length === 0) {
      delete hooksObj[event];
    }
  }

  if (Object.keys(hooksObj).length === 0) {
    delete root.hooks;
  }
}

function findHookToRemove(hooksObj: Record<string, unknown>, change: ResolvedChange): HookDisableMatch {
  const event = change.item.hookEvent;
  if (!event || !Array.isArray(hooksObj[event])) {
    throw new Error('Hook not found in event configuration');
  }
  const found = (hooksObj[event] as unknown[]).flatMap((entry, groupIdx) => matchesIn(entry, groupIdx, change, event));
  if (found.length === 0) {
    throw new Error('Hook not found in configuration');
  }
  if (found.length > 1) {
    // Removing the first of several matches could remove a hook the user (or wmux) still needs.
    throw new Error(AMBIGUOUS_HOOK);
  }
  return found[0];
}

/** The handlers of one event entry (a matcher group or a bare handler) that are this change's hook. */
function matchesIn(entry: unknown, groupIdx: number, change: ResolvedChange, event: string): HookDisableMatch[] {
  const groupOrHandler = entry as Record<string, unknown>;
  if (groupOrHandler && Array.isArray(groupOrHandler.hooks)) {
    const groupMeta = groupMetaOf(groupOrHandler);
    return (groupOrHandler.hooks as ClaudeHookHandler[]).flatMap((handler, handlerIdx) =>
      handlerMatchesItem(handler, change.item, event, groupMeta)
        ? [{ change, event, groupIdx, handlerIdx, handler, groupMeta }]
        : [],
    );
  }
  if (groupOrHandler && typeof groupOrHandler === 'object') {
    const handler = groupOrHandler as ClaudeHookHandler;
    if (handlerMatchesItem(handler, change.item, event, undefined)) {
      return [{ change, event, groupIdx, handlerIdx: null, handler }];
    }
  }
  return [];
}

/** Persists the removed hooks so they can be restored. An id that already holds a different hook is refused. */
function saveRemovedHooks(matches: HookDisableMatch[], targetPath: string, store: SurfacesStore): void {
  // Overwriting it would lose the first hook's saved definition.
  if (matches.some((m) => storeHoldsOtherHook(store, m))) {
    throw new Error(AMBIGUOUS_HOOK);
  }
  for (const match of matches) {
    const definition: ClaudeRemovedHookDefinition = {
      event: match.event,
      groupMeta: match.groupMeta,
      handler: match.handler,
    };
    store.removedHooks.add('claude', {
      id: match.change.item.id,
      definition,
      originPath: targetPath,
    });
  }
  store.save();
}

function storeHoldsOtherHook(store: SurfacesStore, match: HookDisableMatch): boolean {
  const existing = store.removedHooks.get('claude', match.change.item.id);
  if (!existing) return false;
  const def = existing.definition as Record<string, unknown>;
  const stored = def.handler && typeof def.handler === 'object'
    ? hookFingerprint(String(def.event ?? ''), def.groupMeta as Record<string, unknown> | undefined, def.handler as Record<string, unknown>)
    : null;
  return stored !== hookFingerprint(match.event, match.groupMeta, match.handler);
}

/**
 * Deletes the matched handlers from the highest index down, then the matcher groups this edit emptied
 * and the matched bare handlers, also from the highest index down.
 */
function removeMatches(eventList: unknown[], eventMatches: HookDisableMatch[]): void {
  const inGroups = eventMatches
    .filter((m) => m.handlerIdx !== null)
    .sort((a, b) => (b.handlerIdx ?? 0) - (a.handlerIdx ?? 0));
  for (const m of inGroups) {
    (eventList[m.groupIdx] as ClaudeMatcherGroup).hooks.splice(m.handlerIdx ?? 0, 1);
  }
  for (let gIdx = eventList.length - 1; gIdx >= 0; gIdx--) {
    if (entryRemovedHere(eventList[gIdx], gIdx, eventMatches)) {
      eventList.splice(gIdx, 1);
    }
  }
}

function entryRemovedHere(entry: unknown, gIdx: number, eventMatches: HookDisableMatch[]): boolean {
  if (isMatcherGroup(entry)) {
    // Only a group this edit emptied; a group the user left empty stays as it was.
    return entry.hooks.length === 0 && eventMatches.some((m) => m.groupIdx === gIdx && m.handlerIdx !== null);
  }
  return !!entry && typeof entry === 'object' && eventMatches.some((m) => m.groupIdx === gIdx && m.handlerIdx === null);
}

/** Puts a removed hook back: into a group with the same matcher fields, a new group, or as a bare handler. */
function restoreHook(root: Record<string, unknown>, change: ResolvedChange, store: SurfacesStore): void {
  const entry = store.removedHooks.get('claude', change.item.id);
  if (!entry) {
    throw new Error('Cannot enable hook: definition not found in store');
  }
  const def = entry.definition as Record<string, unknown>;
  const handler = storedHandler(def);
  const event = (def.event as string) || change.item.hookEvent || 'PreToolUse';
  const groupMeta = def.groupMeta as Record<string, unknown> | undefined;
  const eventList = eventListFor(root, event);

  if (groupMeta === undefined) {
    if (!eventList.some((h) => deepEqual(h, handler))) {
      eventList.push(handler);
    }
    return;
  }
  const groups = eventList.filter(
    (g): g is ClaudeMatcherGroup => isMatcherGroup(g) && deepEqual(groupMetaOf(g), groupMeta),
  );
  if (groups.some((g) => g.hooks.some((h) => deepEqual(h, handler)))) {
    return;
  }
  if (groups.length > 0) {
    groups[0].hooks.push(handler);
  } else {
    eventList.push({ ...groupMeta, hooks: [handler] });
  }
}

function storedHandler(def: Record<string, unknown>): ClaudeHookHandler {
  if (def.handler && typeof def.handler === 'object' && !Array.isArray(def.handler)) {
    return def.handler as ClaudeHookHandler;
  }
  // Older entries stored the handler's fields next to `event` and `groupMeta`.
  const fallback: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (k !== 'event' && k !== 'groupMeta') {
      fallback[k] = v;
    }
  }
  return fallback;
}

/** The event's handler list in `root.hooks`, created when missing. */
function eventListFor(root: Record<string, unknown>, event: string): unknown[] {
  if (!root.hooks || typeof root.hooks !== 'object') {
    root.hooks = {};
  }
  const hooksObj = root.hooks as Record<string, unknown>;
  if (!Array.isArray(hooksObj[event])) {
    hooksObj[event] = [];
  }
  return hooksObj[event] as unknown[];
}
