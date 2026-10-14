// Characterization of the Claude Code writer: buildSettingsEdits (every item
// kind, both directions, odd file shapes), applyHookChangesToRoot (removal and
// restore of hooks, its errors, the store it writes) and createClaudeWriter's
// apply end to end. Each scenario compares the WHOLE outcome with a recorded
// golden file in ./fixtures/claude-settings: JSON edits in order, file edit
// summaries in order, affected ids, the settings root after the change (key
// order included), the surfaces store on disk, files written and the error.
// The goldens pin today's behaviour so these functions can be restructured.
//
// Portable across OSes: the temp home and project become <home>/<project> with
// '/' separators (realpath too: macOS tmp is a symlink), backups are counted.
//
// Re-record only on purpose: WMUX_RECORD_CLAUDE_SETTINGS=1 npx vitest run <this file>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SurfaceItem, SurfaceKind, SurfaceSource } from '../../../../shared/tokenUsage/surfaceTypes';
import { hookFingerprint } from '../../inventory/helpers';
import { SurfacesStore, type JsonEdit } from '../../safeWrite';
import { buildSettingsEdits } from '../claude/settingsTarget';
import { applyHookChangesToRoot } from '../claude/hookTarget';
import { createClaudeWriter } from '../claudeWriter';
import type { ResolvedChange, WriterDeps } from '../types';

const RECORD = process.env.WMUX_RECORD_CLAUDE_SETTINGS === '1';
const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'claude-settings');

let home: string;
let project: string;
let tokens: [string, string][];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-char-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-char-proj-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  tokens = [];
  for (const [dir, token] of [[home, '<home>'], [project, '<project>']] as const) {
    for (const p of new Set([dir, fs.realpathSync(dir), fs.realpathSync.native(dir)])) {
      tokens.push([p, token], [p.replace(/\\/g, '/'), token]);
    }
  }
  tokens.sort((a, b) => b[0].length - a[0].length);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function portable(value: string): string {
  let s = value;
  for (const [abs, token] of tokens) s = s.split(abs).join(token);
  return s.replace(/\\/g, '/');
}

function portableDeep(value: unknown): unknown {
  if (typeof value === 'string') return portable(value);
  if (Array.isArray(value)) return value.map(portableDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [portable(k), portableDeep(v)]));
  }
  return value;
}

function golden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  // Compared as text, so key order (what a settings file is written in) is pinned too.
  const text = JSON.stringify(portableDeep(actual), null, 2) + '\n';
  if (RECORD) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  expect(text).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

function deps(withProject = true): WriterDeps {
  return {
    homeDir: home,
    projectDir: withProject ? project : undefined,
    run: async () => '2.1.0',
    now: () => 1_700_000_000_000,
    surfacesStorePath: path.join(home, '.wmux', 'surfaces.json'),
  };
}

interface ItemOpts {
  parent?: string;
  source?: SurfaceSource;
  hookEvent?: string;
  hookFingerprint?: string;
  originPath?: string;
  settingsPath?: string;
}

function item(kind: SurfaceKind, name: string, o: ItemOpts = {}): SurfaceItem {
  return {
    id: `claude:${kind}:${encodeURIComponent(o.parent ?? '')}:${encodeURIComponent(name)}`,
    provider: 'claude',
    kind,
    name,
    parent: o.parent ?? null,
    source: o.source ?? 'user',
    enabled: null,
    effect: 'removes',
    toggleable: true,
    readOnlyReason: null,
    hookEvent: o.hookEvent ?? null,
    hookCost: null,
    hookFingerprint: o.hookFingerprint,
    descriptionChars: null,
    originPath: o.originPath ?? null,
    settingsPath: o.settingsPath,
    wmuxRequired: false,
  };
}

const off = (i: SurfaceItem): ResolvedChange => ({ item: i, enabled: false });
const on = (i: SurfaceItem): ResolvedChange => ({ item: i, enabled: true });

function readStore(): unknown {
  const p = deps().surfacesStorePath;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function seedStore(removed: unknown[]): void {
  const p = deps().surfacesStorePath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, removedHooks: { claude: removed } }));
}

function openStore(): SurfacesStore {
  const store = new SurfacesStore(deps().surfacesStorePath);
  store.load();
  return store;
}

const userSettings = () => path.join(home, '.claude', 'settings.json');

/** buildSettingsEdits in preview mode over a snapshot text; the root it would write is rebuilt from the edits. */
function plan(text: string | null, changes: ResolvedChange[], target = userSettings()) {
  const r = buildSettingsEdits(target, deps(), changes, false, undefined, text);
  return { ...r, rootKeys: rootAfter(text, r.edits) };
}

/** Top-level keys, in order, of the file a JSON writer produces from these edits (sets keep position, new keys append). */
function rootAfter(text: string | null, edits: JsonEdit[]): string[] {
  let root: Record<string, unknown> = {};
  try { root = text ? JSON.parse(text) : {}; } catch { root = {}; }
  for (const e of edits) {
    const key = String(e.path[0]);
    if (e.op === 'delete') delete root[key];
    else root[key] = e.value;
  }
  return Object.keys(root);
}

describe('Claude settings writer characterization', () => {
  it('disables one item of every kind', () => {
    const text = JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Read'], deny: ['Bash'] },
      deniedMcpServers: [{ serverName: 'already-denied' }],
      enabledPlugins: { 'p@m': true },
      skillOverrides: { other: 'off' },
      includeCoAuthoredBy: true,
      disableAllHooks: false,
      cleanupPeriodDays: 30,
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    }, null, 2);
    golden('settings-disable-all-kinds', plan(text, [
      off(item('mcp-server', 'user-server')),
      off(item('mcp-server', 'already-denied')),
      off(item('mcp-server', 'proj-server', { source: 'project' })),
      off(item('mcp-tool', 'search', { parent: 'web' })),
      off(item('builtin-tool', 'Bash')),
      off(item('builtin-tool', 'WebFetch')),
      off(item('plugin', 'p@m', { source: 'plugin' })),
      off(item('skill', 'writer')),
      off(item('skill', 'plugin-skill', { source: 'plugin' })),
      off(item('context-setting', 'includeCoAuthoredBy')),
      off(item('context-setting', 'disableAllHooks')),
      off(item('context-setting', 'cleanupPeriodDays')),
      off(item('context-setting', 'notInFile')),
      off(item('hook', 'Stop-command', { hookEvent: 'Stop' })),
      off(item('hook', 'managed-hook', { source: 'managed', hookEvent: 'Stop' })),
    ]));
  });

  it('enables one item of every kind', () => {
    const text = JSON.stringify({
      deniedMcpServers: [{ serverName: 'a' }, { serverName: 'b' }, 'not-an-object', null],
      permissions: { deny: ['mcp__web__search', 'Bash', 'WebFetch'] },
      enabledPlugins: { 'p@m': false },
      skillOverrides: { writer: 'off' },
      includeCoAuthoredBy: false,
      disableAllHooks: true,
    });
    golden('settings-enable-all-kinds', plan(text, [
      on(item('mcp-server', 'a')),
      on(item('mcp-server', 'not-denied')),
      on(item('mcp-server', 'proj-not-denied', { source: 'project' })),
      on(item('mcp-tool', 'search', { parent: 'web' })),
      on(item('builtin-tool', 'Bash')),
      on(item('builtin-tool', 'NotDenied')),
      on(item('plugin', 'p@m', { source: 'plugin' })),
      on(item('plugin', 'new@m', { source: 'plugin' })),
      on(item('skill', 'writer')),
      on(item('skill', 'never-off')),
      on(item('context-setting', 'includeCoAuthoredBy')),
      on(item('context-setting', 'disableAllHooks')),
      on(item('hook', 'Stop-command', { hookEvent: 'Stop' })),
      on(item('hook', 'no-event')),
    ]));
  });

  it('cleans up emptied lists and objects, and keeps what else is there', () => {
    golden('settings-cleanup', {
      lastDeniedServer: plan(JSON.stringify({ a: 1, deniedMcpServers: [{ serverName: 's' }], z: 2 }), [on(item('mcp-server', 's'))]),
      lastDenyEmptiesPermissions: plan(JSON.stringify({ a: 1, permissions: { deny: ['Bash'] }, z: 2 }), [on(item('builtin-tool', 'Bash'))]),
      lastDenyKeepsAllow: plan(JSON.stringify({ permissions: { allow: ['Read'], deny: ['mcp__s__t'] } }), [on(item('mcp-tool', 't', { parent: 's' }))]),
      denyEmptyArrayStays: plan(JSON.stringify({ permissions: { deny: [] } }), [on(item('builtin-tool', 'Bash'))]),
      lastOverride: plan(JSON.stringify({ skillOverrides: { writer: 'off' }, z: 1 }), [on(item('skill', 'writer'))]),
      twoToolsOneFile: plan(JSON.stringify({ permissions: { deny: ['Bash', 'mcp__s__t'] } }), [on(item('builtin-tool', 'Bash')), on(item('mcp-tool', 't', { parent: 's' }))]),
      disableThenNewKeysAppend: plan(JSON.stringify({ b: 1, a: 2 }), [off(item('skill', 'x')), off(item('builtin-tool', 'Bash')), off(item('mcp-server', 'm'))]),
    });
  });

  it('reads odd file shapes the way it always has', () => {
    golden('settings-odd-shapes', {
      noFile: plan(null, [off(item('builtin-tool', 'Bash')), on(item('skill', 'writer'))]),
      invalidJson: plan('{ not json', [off(item('builtin-tool', 'Bash'))]),
      emptyText: plan('', [off(item('builtin-tool', 'Bash'))]),
      deniedNotArray: plan(JSON.stringify({ deniedMcpServers: { serverName: 'x' } }), [off(item('mcp-server', 'x')), on(item('mcp-server', 'y'))]),
      permissionsNotObject: plan(JSON.stringify({ permissions: 'all' }), [off(item('builtin-tool', 'Bash')), off(item('mcp-tool', 't', { parent: 's' }))]),
      permissionsNotObjectEnable: plan(JSON.stringify({ permissions: 'all' }), [on(item('builtin-tool', 'Bash'))]),
      denyNotArray: plan(JSON.stringify({ permissions: { deny: 'Bash' } }), [off(item('builtin-tool', 'Bash')), on(item('mcp-tool', 't', { parent: 's' }))]),
      pluginsNotObject: plan(JSON.stringify({ enabledPlugins: ['x'] }), [off(item('plugin', 'p@m', { source: 'plugin' }))]),
      overridesNotObject: plan(JSON.stringify({ skillOverrides: 'off' }), [off(item('skill', 'w')), on(item('skill', 'v'))]),
      pathOutsideHomeAndProject: buildSettingsEdits(path.join(os.tmpdir(), 'elsewhere', 'settings.json'), deps(), [off(item('builtin-tool', 'Bash'))], false, undefined, '{}'),
    });
  });

  it('reads the file from disk when no snapshot text is given', () => {
    fs.writeFileSync(userSettings(), JSON.stringify({ permissions: { deny: ['Bash'] } }));
    const r = buildSettingsEdits(userSettings(), deps(), [on(item('builtin-tool', 'Bash')), off(item('builtin-tool', 'Read'))], false);
    const missing = buildSettingsEdits(path.join(project, '.claude', 'settings.local.json'), deps(), [off(item('builtin-tool', 'Bash'))], false);
    golden('settings-from-disk', { r, missing });
  });

  it('removes hooks: handlers, bare handlers, groups and events, highest index first', () => {
    const fpHandler = { type: 'command', command: 'lint' };
    const root: Record<string, unknown> = {
      first: true,
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'a', name: 'h-a' }, { type: 'command', command: 'b', name: 'h-b' }, { type: 'command', command: 'c', name: 'h-c' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'd', name: 'h-d' }] },
          { matcher: 'Left-empty-by-user', hooks: [] },
          { type: 'command', command: 'bare', name: 'h-bare' },
          { matcher: 'Write', hooks: [fpHandler, { type: 'prompt', prompt: 'p' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'only' }] }],
        Notification: [{ type: 'command', command: 'n', name: 'keep' }],
      },
      last: true,
    };
    const store = openStore();
    applyHookChangesToRoot(root, [
      off(item('hook', 'h-c', { hookEvent: 'PreToolUse' })),
      off(item('hook', 'h-a', { hookEvent: 'PreToolUse' })),
      off(item('hook', 'h-d', { hookEvent: 'PreToolUse' })),
      off(item('hook', 'h-bare', { hookEvent: 'PreToolUse' })),
      off(item('hook', 'PreToolUse-command', { hookEvent: 'PreToolUse', hookFingerprint: hookFingerprint('PreToolUse', { matcher: 'Write' }, fpHandler) })),
      off(item('hook', 'Stop-command', { hookEvent: 'Stop' })),
    ], userSettings(), store);
    golden('hooks-remove', { root, rootKeys: Object.keys(root), store: readStore() });

    fs.rmSync(deps().surfacesStorePath, { force: true });
    const all: Record<string, unknown> = { hooks: { Stop: [{ type: 'command', command: 'x' }] }, other: 1 };
    applyHookChangesToRoot(all, [off(item('hook', 'Stop-command', { hookEvent: 'Stop' }))], userSettings(), openStore());
    golden('hooks-remove-last', { root: all, store: readStore() });
  });

  it('refuses to remove a hook it cannot pin down, before touching the root or the store', () => {
    const outcome = (root: Record<string, unknown>, changes: ResolvedChange[], seed?: unknown[]) => {
      if (seed) seedStore(seed); else fs.rmSync(deps().surfacesStorePath, { force: true });
      const before = JSON.stringify(root);
      let error: string | null = null;
      try { applyHookChangesToRoot(root, changes, userSettings(), openStore()); } catch (e) { error = (e as Error).message; }
      return { error, rootChanged: JSON.stringify(root) !== before, store: readStore() };
    };
    const twoSame = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'y' }] }] } };
    golden('hooks-remove-errors', {
      noHooks: outcome({}, [off(item('hook', 'x', { hookEvent: 'Stop' }))]),
      hooksNotObject: outcome({ hooks: 'x' }, [off(item('hook', 'x', { hookEvent: 'Stop' }))]),
      noEvent: outcome({ hooks: { Stop: [] } }, [off(item('hook', 'x'))]),
      eventNotArray: outcome({ hooks: { Stop: {} } }, [off(item('hook', 'x', { hookEvent: 'Stop' }))]),
      noMatch: outcome({ hooks: { Stop: [{ hooks: [{ type: 'command', name: 'a' }] }, null, 7] } }, [off(item('hook', 'zzz', { hookEvent: 'Stop' }))]),
      twoMatches: outcome(twoSame, [off(item('hook', 'Stop-command', { hookEvent: 'Stop' }))]),
      secondChangeFails: outcome({ hooks: { Stop: [{ type: 'command', name: 'ok' }] } }, [off(item('hook', 'ok', { hookEvent: 'Stop' })), off(item('hook', 'missing', { hookEvent: 'Stop' }))]),
      idHoldsOtherHook: outcome({ hooks: { Stop: [{ type: 'command', name: 'ok', command: 'new' }] } }, [off(item('hook', 'ok', { hookEvent: 'Stop' }))], [
        { id: item('hook', 'ok').id, definition: { event: 'Stop', handler: { type: 'command', name: 'ok', command: 'old' } }, originPath: userSettings() },
      ]),
      idHoldsLegacyEntry: outcome({ hooks: { Stop: [{ type: 'command', name: 'ok' }] } }, [off(item('hook', 'ok', { hookEvent: 'Stop' }))], [
        { id: item('hook', 'ok').id, definition: { event: 'Stop', type: 'command', name: 'ok' } },
      ]),
      idHoldsSameHook: outcome({ hooks: { Stop: [{ type: 'command', name: 'ok' }] } }, [off(item('hook', 'ok', { hookEvent: 'Stop' }))], [
        { id: item('hook', 'ok').id, definition: { event: 'Stop', handler: { type: 'command', name: 'ok' } } },
      ]),
    });
  });

  it('restores hooks into matching groups, new groups or bare, once', () => {
    const h = (cmd: string) => ({ type: 'command', command: cmd });
    const id = (name: string) => item('hook', name).id;
    seedStore([
      { id: id('into-group'), definition: { event: 'PreToolUse', groupMeta: { matcher: 'Bash' }, handler: h('g') } },
      { id: id('already-in-group'), definition: { event: 'PreToolUse', groupMeta: { matcher: 'Bash' }, handler: h('present') } },
      { id: id('new-group'), definition: { event: 'PreToolUse', groupMeta: { matcher: 'Edit', timeout: 5 }, handler: h('e') } },
      { id: id('bare'), definition: { event: 'Stop', handler: h('s') } },
      { id: id('bare-present'), definition: { event: 'Stop', handler: h('already') } },
      { id: id('legacy'), definition: { event: 'Notification', groupMeta: { matcher: '' }, type: 'command', command: 'legacy' } },
      { id: id('no-event'), definition: { handler: h('falls back to the item event') } },
      { id: id('no-event-anywhere'), definition: { handler: h('falls back to PreToolUse') } },
      { id: id('array-handler'), definition: { event: 'Stop', handler: ['x'], command: 'from the entry' } },
    ]);
    const root: Record<string, unknown> = {
      a: 1,
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [h('present')] }, { matcher: 'Bash', hooks: [] }],
        Stop: [h('already')],
        SessionStart: 'not an array',
      },
    };
    applyHookChangesToRoot(root, [
      on(item('hook', 'into-group')),
      on(item('hook', 'already-in-group')),
      on(item('hook', 'new-group')),
      on(item('hook', 'bare')),
      on(item('hook', 'bare-present')),
      on(item('hook', 'legacy')),
      on(item('hook', 'no-event', { hookEvent: 'SessionStart' })),
      on(item('hook', 'no-event-anywhere')),
      on(item('hook', 'array-handler')),
    ], userSettings(), openStore());
    const noHooks: Record<string, unknown> = { hooks: 'x' };
    applyHookChangesToRoot(noHooks, [on(item('hook', 'bare'))], userSettings(), openStore());
    let missing: string | null = null;
    try { applyHookChangesToRoot({}, [on(item('hook', 'not-in-store'))], userSettings(), openStore()); } catch (e) { missing = (e as Error).message; }
    golden('hooks-restore', { root, rootKeys: Object.keys(root), noHooks, missing, store: readStore() });
  });

  it('removes and restores hooks in one settings plan when applying', () => {
    const h = (cmd: string) => ({ type: 'command', command: cmd });
    seedStore([{ id: item('hook', 'back').id, definition: { event: 'Stop', handler: h('back') } }]);
    const text = JSON.stringify({ hooks: { Stop: [{ type: 'command', command: 'go', name: 'go' }] }, permissions: { deny: ['Bash'] } });
    const store = openStore();
    const r = buildSettingsEdits(userSettings(), deps(), [off(item('hook', 'go', { hookEvent: 'Stop' })), on(item('hook', 'back', { hookEvent: 'Stop' })), on(item('builtin-tool', 'Bash'))], true, store, text);
    const noStore = buildSettingsEdits(userSettings(), deps(), [off(item('hook', 'go', { hookEvent: 'Stop' }))], true, undefined, text);
    golden('settings-apply-hooks', { r, noStore, store: readStore() });
  });

  describe('createClaudeWriter().apply', () => {
    const files = () => {
      const out: Record<string, unknown> = {};
      for (const p of [path.join(home, '.claude.json'), userSettings(), path.join(project, '.claude', 'settings.local.json'), path.join(project, '.claude', 'settings.json')]) {
        out[p] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      }
      return out;
    };
    const apply = async (changes: ResolvedChange[], withProject = true) => {
      const d = deps(withProject);
      try {
        const res = await createClaudeWriter().apply({ deps: d, inventory: { provider: 'claude', cliVersion: '2.1.0', versionSupported: true, writable: true, items: [], warnings: [], scannedAtMs: 0 } as never, changes });
        return { result: { ...res, backups: res.backups.length }, files: files(), store: readStore() };
      } catch (e) {
        return { thrown: (e as Error).message, files: files(), store: readStore() };
      }
    };

    it('writes ~/.claude.json, user and project settings, and the store, in one apply', async () => {
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { disabledMcpServers: ['p2'] } } }, null, 2));
      fs.writeFileSync(userSettings(), JSON.stringify({ hooks: { Stop: [{ type: 'command', name: 'go' }] } }, null, 2));
      fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }, null, 2));
      seedStore([{ id: item('hook', 'back').id, definition: { event: 'Stop', handler: { type: 'command', command: 'back' } } }]);
      golden('writer-apply-mixed', await apply([
        off(item('mcp-server', 'p1', { source: 'project' })),
        on(item('mcp-server', 'p2', { source: 'project' })),
        on(item('mcp-server', 'p3', { source: 'project' })),
        off(item('mcp-server', 'u1')),
        off(item('hook', 'go', { hookEvent: 'Stop' })),
        on(item('hook', 'back', { hookEvent: 'Stop' })),
        on(item('builtin-tool', 'Bash', { source: 'project', originPath: path.join(project, '.claude', 'settings.json'), settingsPath: path.join(project, '.claude', 'settings.json') })),
        off(item('skill', 'proj-skill', { source: 'project' })),
        on(item('skill', 'never-off')),
      ]));
    });

    it('reports what it could not apply, and fails without a project directory or a stored hook', async () => {
      fs.writeFileSync(userSettings(), JSON.stringify({ permissions: { deny: ['Bash'] } }, null, 2));
      const partial = await apply([on(item('builtin-tool', 'Bash')), on(item('builtin-tool', 'NotDenied'))]);
      const noProject = await apply([off(item('mcp-server', 'p', { source: 'project' }))], false);
      const missingHook = await apply([off(item('builtin-tool', 'Read')), on(item('hook', 'gone', { hookEvent: 'Stop' }))]);
      fs.writeFileSync(userSettings(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command' }, { type: 'command' }] }] } }));
      const ambiguous = await apply([off(item('hook', 'Stop-command', { hookEvent: 'Stop' }))]);
      golden('writer-apply-failures', { partial, noProject, missingHook, ambiguous });
    });
  });
});
