import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginHostLoader } from '../PluginHostLoader';
import { UiPluginManager } from '../UiPluginManager';
import { ApprovalQueue } from '../../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ui-plugin-manager-'));
  roots.push(root);
  const records = new Map<string, { name: string; status: string }>();
  const trust = {
    get: vi.fn(async (name: string) => records.get(name)),
    upsertDeclaration: vi.fn(async (name: string) => { if (!records.has(name)) records.set(name, { name, status: 'unconfirmed' }); return records.get(name); }),
    setUserDecision: vi.fn(async (name: string, status: string) => { records.set(name, { name, status }); return records.get(name); }),
  } as unknown as PluginTrustStore;
  const pluginsDir = path.join(root, 'plugins');
  const catalogDir = path.join(root, 'catalog');
  fs.mkdirSync(catalogDir);
  fs.cpSync(path.resolve('examples/plugins/agent-state-page'), path.join(catalogDir, 'agent-state-page'), { recursive: true });
  const loader = new PluginHostLoader(trust, pluginsDir);
  const approval = new ApprovalQueue(trust, { openPrompt: vi.fn() });
  const options = { loader, trust, approval: () => approval, pluginsDir, catalogDir, statePath: path.join(root, 'ui-plugins.json'), changed: vi.fn() };
  return { root, options, loader, trust, approval, manager: new UiPluginManager(options) };
}

it('installs without granting permissions, disables immediately and persists across restart', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  expect((await test.manager.inventory()).plugins[0]).toMatchObject({ managed: true, enabled: true, trustStatus: 'denied' });
  expect(test.loader.resolveBundlePath('agent-state-page', 'page.html')).not.toBeNull();
  await test.trust.setUserDecision('agent-state-page', 'trusted');
  const handle = test.approval.requestApproval({ clientName: 'agent-state-page', declaredCapabilities: ['ui.rail-page'] });
  const rejected = expect(handle.resolution).rejects.toThrow('cancelled');
  await test.manager.setEnabled('agent-state-page', false);
  await rejected;
  expect(test.loader.get('agent-state-page')).toBeUndefined();
  expect(test.loader.resolveBundlePath('agent-state-page', 'page.html')).toBeNull();
  expect(await test.loader.summaries()).toEqual([]);
  const restartedLoader = new PluginHostLoader(test.trust, test.options.pluginsDir);
  const restarted = new UiPluginManager({ ...test.options, loader: restartedLoader });
  await restarted.initialize();
  expect(restartedLoader.get('agent-state-page')).toBeUndefined();
  expect((await restarted.inventory()).plugins[0]).toMatchObject({ enabled: false, trustStatus: 'trusted' });
  await restarted.setEnabled('agent-state-page', true);
  expect(restartedLoader.get('agent-state-page')).toBeDefined();
});

it('removes only a managed bundle and requires a fresh approval after reinstall', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  await test.trust.setUserDecision('agent-state-page', 'trusted');
  await test.manager.remove('agent-state-page');
  expect(fs.existsSync(path.join(test.options.pluginsDir, 'agent-state-page'))).toBe(false);
  expect(test.loader.get('agent-state-page')).toBeUndefined();
  expect((await test.manager.inventory()).failures).toEqual([]);
  await test.manager.install('agent-state-page');
  expect((await test.manager.inventory()).plugins[0].trustStatus).toBe('denied');
});

it('retains disabled management ownership after interruption at bundle publication', async () => {
  const test = setup();
  const recovery = setup();
  await test.manager.initialize();
  const loadAll = test.loader.loadAll.bind(test.loader);
  vi.spyOn(test.loader, 'loadAll').mockImplementationOnce(async () => {
    // Snapshot the disk checkpoint immediately after rename, before final persistence.
    fs.copyFileSync(test.options.statePath, recovery.options.statePath);
    fs.cpSync(test.options.pluginsDir, recovery.options.pluginsDir, { recursive: true });
    return loadAll();
  });
  await test.manager.install('agent-state-page');
  await recovery.manager.initialize();
  expect((await recovery.manager.inventory()).plugins[0]).toMatchObject({ managed: true, enabled: false });
  expect(recovery.loader.get('agent-state-page')).toBeUndefined();
  await recovery.manager.remove('agent-state-page');
  expect(fs.existsSync(path.join(recovery.options.pluginsDir, 'agent-state-page'))).toBe(false);
});

it('rejects arbitrary IDs, traversal, duplicate installs and symlink roots without modifying targets', async () => {
  const test = setup();
  await test.manager.initialize();
  await expect(test.manager.install('../outside')).rejects.toThrow('Unknown catalog');
  await expect(test.manager.install('https://example.test/plugin')).rejects.toThrow('Unknown catalog');
  const outside = path.join(test.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, test.options.pluginsDir, 'junction');
  await expect(test.manager.install('agent-state-page')).rejects.toThrow('symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
  fs.unlinkSync(test.options.pluginsDir);
  const results = await Promise.allSettled([test.manager.install('agent-state-page'), test.manager.install('agent-state-page')]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(fs.existsSync(path.join(test.options.pluginsDir, 'agent-state-page', 'page.html'))).toBe(true);
});

it('never overwrites or removes manually installed bundles', async () => {
  const test = setup();
  fs.mkdirSync(test.options.pluginsDir);
  const destination = path.join(test.options.pluginsDir, 'agent-state-page');
  fs.cpSync(path.join(test.options.catalogDir, 'agent-state-page'), destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'user content');
  await test.manager.initialize();
  await expect(test.manager.install('agent-state-page')).rejects.toThrow('already installed');
  await expect(test.manager.remove('agent-state-page')).rejects.toThrow('Only catalog-installed');
  expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('user content');
  await test.manager.setEnabled('agent-state-page', false);
  expect(test.loader.get('agent-state-page')).toBeUndefined();
});

it('fails closed on malformed persisted settings', async () => {
  const test = setup();
  fs.writeFileSync(test.options.statePath, '{bad');
  await expect(test.manager.initialize()).rejects.toThrow();
  expect(test.loader.list()).toEqual([]);
});

it('can remove a managed bundle even when its manifest is corrupt', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  fs.writeFileSync(path.join(test.options.pluginsDir, 'agent-state-page', 'manifest.json'), '{broken');
  await test.loader.loadAll();
  expect((await test.manager.inventory()).plugins[0]).toMatchObject({ managed: true, invalid: true });
  await test.manager.remove('agent-state-page');
  expect((await test.manager.inventory()).plugins).toEqual([]);
});
