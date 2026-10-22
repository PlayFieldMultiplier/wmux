import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { PLUGIN_NAME_REGEX } from '../../shared/pluginHost';
import { UI_PLUGIN_CATALOG, type UiPluginInventory } from '../../shared/pluginManagement';
import type { ApprovalQueue } from '../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../mcp/PluginTrustStore';
import type { PluginHostLoader } from './PluginHostLoader';
import { copyCatalogBundle } from './copyCatalogBundle';
import { compareSemver, parseSemver } from '../surfaces/safeWrite/versionRange';

type SavedState = { version: 1; disabled: string[]; managed: string[] };

/**
 * Where a refresh parks the bundle it replaces until the new one is published:
 * `.retired@<id>@<uuid>`. `@` cannot occur in a plugin name, so the id reads
 * back unambiguously, and the leading dot keeps the loader from scanning it.
 */
const RETIRED_PREFIX = '.retired@';
/** Leftovers of an interrupted install, removal or refresh. None is ever a live bundle. */
const LEFTOVER_PREFIXES = ['.install-', '.removed-', RETIRED_PREFIX];

/** Owner UI lifecycle for a finite catalog of shipped, original bundles. */
export class UiPluginManager {
  private state: SavedState = { version: 1, disabled: [], managed: [] };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    loader: PluginHostLoader;
    trust: PluginTrustStore;
    approval: () => ApprovalQueue | null;
    pluginsDir: string;
    statePath: string;
    catalogDir: string;
    changed: (name: string) => void;
  }) {}

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) as SavedState;
      if (raw.version !== 1 || !Array.isArray(raw.disabled) || !Array.isArray(raw.managed)
        || [...raw.disabled, ...raw.managed].some((name) => typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name))) {
        throw new Error('Invalid UI plugin settings');
      }
      this.state = { version: 1, disabled: [...new Set(raw.disabled)], managed: [...new Set(raw.managed)] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.recoverInterruptedWork();
    this.refreshManagedBundles();
    this.options.loader.setDisabled(this.state.disabled);
    await this.options.loader.loadAll();
  }

  /**
   * A catalog-installed bundle older than the one this build ships is replaced
   * by the shipped one before the first load. Only bundles in the install
   * ledger are refreshed; one placed by hand is never touched. Approval is not
   * handled here: the load that follows registers the new declaration, and a
   * wider one drops an approved plugin back to unconfirmed (applyDeclaration),
   * so the owner is asked again. A refresh that fails keeps the old bundle.
   */
  private refreshManagedBundles(): void {
    for (const entry of UI_PLUGIN_CATALOG) {
      if (!this.state.managed.includes(entry.id)) continue;
      try {
        this.refreshBundle(entry);
      } catch (error) {
        console.warn(`[UiPluginManager] could not update ${entry.id}:`, error);
      }
    }
  }

  /**
   * A refresh that stopped between its two renames left the managed bundle's
   * folder missing and the old bundle parked: put it back, so the refresh
   * that follows starts over from it. Then remove what interrupted installs,
   * removals and refreshes left behind. Only real directories are touched; a
   * link is left alone, so nothing behind it can be deleted.
   */
  private recoverInterruptedWork(): void {
    if (!fs.existsSync(this.options.pluginsDir)) return;
    let root: string;
    let names: string[];
    try {
      root = this.root();
      names = fs.readdirSync(root);
    } catch (error) {
      console.warn('[UiPluginManager] could not check for interrupted plugin updates:', error);
      return;
    }
    const isDirectory = (name: string) => {
      const stat = fs.lstatSync(path.join(root, name));
      return stat.isDirectory() && !stat.isSymbolicLink();
    };
    for (const id of this.state.managed) {
      const parked = names.find((name) => name.startsWith(RETIRED_PREFIX) && name.split('@')[1] === id);
      if (!parked) continue;
      try {
        if (fs.existsSync(path.join(root, id)) || !isDirectory(parked)) continue;
        fs.renameSync(path.join(root, parked), path.join(root, id));
      } catch (error) {
        console.warn(`[UiPluginManager] could not restore ${id}:`, error);
      }
    }
    for (const name of fs.readdirSync(root)) {
      if (!LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      try {
        // A parked bundle is a leftover only once its plugin's folder is back.
        // While it is missing (the restore above failed), the parked copy may
        // be the only one: keep it for the next start.
        if (name.startsWith(RETIRED_PREFIX) && !this.hasBundleFolder(root, name.split('@')[1])) continue;
        if (isDirectory(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
      } catch (error) {
        console.warn(`[UiPluginManager] could not remove ${name}:`, error);
      }
    }
  }

  private hasBundleFolder(root: string, id: string | undefined): boolean {
    if (!id || !PLUGIN_NAME_REGEX.test(id)) return false;
    try {
      const stat = fs.lstatSync(path.join(root, id));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private refreshBundle(entry: typeof UI_PLUGIN_CATALOG[number]): void {
    const root = this.root();
    const destination = path.join(root, entry.id);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const source = path.join(this.options.catalogDir, entry.id);
    const installed = parseSemver(manifestVersion(path.join(destination, 'manifest.json')));
    const shipped = parseSemver(manifestVersion(path.join(source, 'manifest.json')));
    // Not comparable (a corrupt or hand-edited manifest): leave it be.
    if (!installed || !shipped || compareSemver(shipped, installed) <= 0) return;
    const staging = fs.mkdtempSync(path.join(root, '.install-'));
    const retired = path.join(root, `${RETIRED_PREFIX}${entry.id}@${randomUUID()}`);
    try {
      copyCatalogBundle(source, staging, entry.files);
      // Same publication as install: scans skip dot-prefixed directories, so a
      // load never sees a partial bundle.
      fs.renameSync(destination, retired);
      try { fs.renameSync(staging, destination); } catch (error) {
        // Put the old bundle back. If that fails too, it stays parked, and the
        // next start restores it (recoverInterruptedWork).
        fs.renameSync(retired, destination);
        throw error;
      }
      // Only now is the parked copy no longer the only one.
      fs.rmSync(retired, { recursive: true, force: true });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** The catalog installed `name` (its install ledger, not the name, says so). */
  isManaged(name: string): boolean {
    return this.state.managed.includes(name);
  }

  async inventory(): Promise<UiPluginInventory> {
    await this.chain;
    const plugins = (await this.options.loader.summaries(true)).map((plugin) => ({
      ...plugin, enabled: !this.state.disabled.includes(plugin.name), managed: this.state.managed.includes(plugin.name),
    }));
    const inventory: UiPluginInventory = { plugins, failures: this.options.loader.listFailures() };
    // A corrupt or missing managed bundle must still be removable from Settings.
    for (const name of this.state.managed) {
      if (plugins.some((plugin) => plugin.name === name)) continue;
      inventory.plugins.push({ name, version: '', capabilities: [], activationEvents: [], contributes: {},
        trustStatus: 'denied', enabled: false, managed: true, invalid: true });
    }
    return inventory;
  }

  private notify(name: string): void {
    try { this.options.changed(name); } catch { /* A closing window does not undo persistence. */ }
  }

  private async persist(): Promise<void> {
    await atomicWriteJSON(this.options.statePath, this.state);
  }

  private disableNow(name: string): void {
    this.state.disabled = [...new Set([...this.state.disabled, name])];
    this.options.loader.setDisabled(this.state.disabled);
    this.options.approval()?.cancelPluginApprovals(name, 'UI plugin stopped');
    this.notify(name);
  }

  private async assertInstalled(name: unknown): Promise<string> {
    if (typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name)
      || !(await this.options.loader.summaries(true)).some((plugin) => plugin.name === name)) {
      throw new Error('Unknown UI plugin');
    }
    return name;
  }

  setEnabled(name: unknown, enabled: unknown): Promise<void> {
    return this.serialize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid plugin state');
      const id = await this.assertInstalled(name);
      if (!enabled) {
        this.disableNow(id);
        await this.persist();
      } else {
        const previous = this.state.disabled;
        this.state.disabled = previous.filter((item) => item !== id);
        try { await this.persist(); } catch (error) { this.state.disabled = previous; throw error; }
        this.options.loader.setDisabled(this.state.disabled);
        this.notify(id);
      }
    });
  }

  /** Never follow a plugin-directory symlink for installation or removal. */
  private root(): string {
    fs.mkdirSync(this.options.pluginsDir, { recursive: true });
    if (fs.lstatSync(this.options.pluginsDir).isSymbolicLink()) throw new Error('Plugin directory must not be a symlink');
    return fs.realpathSync(this.options.pluginsDir);
  }

  install(catalogId: unknown): Promise<void> {
    return this.serialize(async () => {
      const entry = UI_PLUGIN_CATALOG.find((item) => item.id === catalogId);
      if (!entry) throw new Error('Unknown catalog entry');
      const root = this.root();
      const destination = path.join(root, entry.id);
      // lstat also catches dangling symlinks. Existing user bundles are never overwritten.
      try { fs.lstatSync(destination); throw new Error('Plugin is already installed'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const staging = fs.mkdtempSync(path.join(root, '.install-'));
      let installed = false;
      this.disableNow(entry.id);
      try {
        const sourceDirectory = path.join(this.options.catalogDir, entry.id);
        copyCatalogBundle(sourceDirectory, staging, entry.files);
        // A new installation always asks for its own approval, even after removal.
        await this.options.trust.setUserDecision(entry.id, 'denied');
        // Record ownership while disabled before publishing the bundle. If the
        // process exits mid-install, Settings can still remove the interrupted install.
        this.state.managed = [...new Set([...this.state.managed, entry.id])];
        await this.persist();
        fs.renameSync(staging, destination);
        installed = true;
        await this.options.loader.loadAll();
        if (!(await this.options.loader.summaries(true)).some((plugin) => plugin.name === entry.id)) {
          throw new Error('Catalog bundle could not be loaded');
        }
        this.state.disabled = this.state.disabled.filter((name) => name !== entry.id);
        await this.persist();
        this.options.loader.setDisabled(this.state.disabled);
        this.notify(entry.id);
      } catch (error) {
        this.disableNow(entry.id);
        if (installed) fs.rmSync(destination, { recursive: true, force: true });
        this.state.managed = this.state.managed.filter((name) => name !== entry.id);
        await this.options.loader.loadAll();
        throw error;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    });
  }

  remove(name: unknown): Promise<void> {
    return this.serialize(async () => {
      if (typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name)) throw new Error('Unknown UI plugin');
      const id = name;
      if (!this.state.managed.includes(id)) throw new Error('Only catalog-installed bundles can be removed here');
      const destination = path.join(this.root(), id);
      let present = true;
      try {
        const stat = fs.lstatSync(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid installed bundle');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        present = false;
      }
      this.disableNow(id);
      await this.persist();
      await this.options.trust.setUserDecision(id, 'denied');
      // Rename first: serving is already disabled and later scans cannot see a partial bundle.
      const retired = path.join(path.dirname(destination), `.removed-${randomUUID()}`);
      if (present) fs.renameSync(destination, retired);
      this.state.managed = this.state.managed.filter((item) => item !== id);
      try {
        await this.options.loader.loadAll();
        await this.persist();
        this.notify(id);
      } finally { fs.rmSync(retired, { recursive: true, force: true }); }
    });
  }
}

/** A bundle manifest's `version`, or undefined when it cannot be read. */
function manifestVersion(file: string): string | undefined {
  try {
    const version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}
