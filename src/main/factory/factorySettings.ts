// ─── Factory settings — `<wmuxDir>/factory/settings.json` ──────────────────
//
// The few switches the agent factory has (the Factory settings tab): on/off
// (off by default), the HQ workspace, trusted PR authors, the morning report
// time, whether the Verifier runs on the owner's own PRs, the default engine
// for new bots, the factory-wide cap on bots running a turn at once, the cap
// on agents (bots and workers) running together, and the merge lane's
// auto-merge switch (off by default) with its daily cap.
// Fields are sanitised one by one on read and on update: a malformed field
// falls back to its default instead of failing the whole file. A file of
// another version is refused (the factory does not start on it).

import path from 'node:path';
import { BOT_ID_RE, DEFAULT_BOT_ENGINE } from '../../shared/bot';
import {
  DEFAULT_FACTORY_SETTINGS,
  FACTORY_CONCURRENT_BOTS_MAX,
  FACTORY_CONCURRENT_BOTS_MIN,
  FACTORY_LANE_DAILY_CAP_MAX,
  FACTORY_MAX_AGENTS_MAX,
  FACTORY_MAX_AGENTS_MIN,
  FACTORY_SETTINGS_VERSION,
  type FactorySettings,
} from '../../shared/factorySettings';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { sanitizeBotEngine } from './botStore';

// The shape lives in shared/ so the renderer can read it.
export {
  DEFAULT_FACTORY_SETTINGS,
  FACTORY_CONCURRENT_BOTS_MAX,
  FACTORY_CONCURRENT_BOTS_MIN,
  FACTORY_LANE_DAILY_CAP_MAX,
  FACTORY_SETTINGS_VERSION,
  type FactorySettings,
};

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** GitHub login shape. */
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TRUSTED_AUTHORS_MAX = 50;

function cloneDefaults(): FactorySettings {
  return {
    ...DEFAULT_FACTORY_SETTINGS,
    trustedAuthors: [],
    morning: { hour: DEFAULT_FACTORY_SETTINGS.morning.hour, weekdays: [...DEFAULT_FACTORY_SETTINGS.morning.weekdays] },
    defaultEngine: { ...DEFAULT_FACTORY_SETTINGS.defaultEngine },
  };
}

/** Apply the well-formed fields of `raw` over `base`. Pure. */
export function mergeFactorySettings(base: FactorySettings, raw: unknown): FactorySettings {
  const out: FactorySettings = {
    ...base,
    trustedAuthors: [...base.trustedAuthors],
    morning: { hour: base.morning.hour, weekdays: [...base.morning.weekdays] },
    defaultEngine: sanitizeBotEngine(base.defaultEngine) ?? { ...DEFAULT_BOT_ENGINE },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (r.hqWorkspaceId === null) out.hqWorkspaceId = null;
  else if (typeof r.hqWorkspaceId === 'string' && WORKSPACE_ID_RE.test(r.hqWorkspaceId)) out.hqWorkspaceId = r.hqWorkspaceId;
  if (Array.isArray(r.trustedAuthors)) {
    const logins = r.trustedAuthors.filter((a): a is string => typeof a === 'string' && GH_LOGIN_RE.test(a));
    out.trustedAuthors = [...new Set(logins)].slice(0, TRUSTED_AUTHORS_MAX);
  }
  if (r.morning && typeof r.morning === 'object' && !Array.isArray(r.morning)) {
    const m = r.morning as Record<string, unknown>;
    if (Number.isInteger(m.hour) && (m.hour as number) >= 0 && (m.hour as number) <= 23) out.morning.hour = m.hour as number;
    if (Array.isArray(m.weekdays)) {
      const days = m.weekdays.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
      out.morning.weekdays = [...new Set(days)].sort((a, b) => a - b);
    }
  }
  if (typeof r.verifierOnOwnerPrs === 'boolean') out.verifierOnOwnerPrs = r.verifierOnOwnerPrs;
  const engine = sanitizeBotEngine(r.defaultEngine);
  if (engine) out.defaultEngine = engine;
  if (
    Number.isInteger(r.globalConcurrentBots)
    && (r.globalConcurrentBots as number) >= FACTORY_CONCURRENT_BOTS_MIN
    && (r.globalConcurrentBots as number) <= FACTORY_CONCURRENT_BOTS_MAX
  ) {
    out.globalConcurrentBots = r.globalConcurrentBots as number;
  }
  if (
    Number.isInteger(r.maxConcurrentAgents)
    && (r.maxConcurrentAgents as number) >= FACTORY_MAX_AGENTS_MIN
    && (r.maxConcurrentAgents as number) <= FACTORY_MAX_AGENTS_MAX
  ) {
    out.maxConcurrentAgents = r.maxConcurrentAgents as number;
  }
  if (typeof r.laneAutoMerge === 'boolean') out.laneAutoMerge = r.laneAutoMerge;
  if (Number.isInteger(r.laneDailyCap) && (r.laneDailyCap as number) >= 0 && (r.laneDailyCap as number) <= FACTORY_LANE_DAILY_CAP_MAX) {
    out.laneDailyCap = r.laneDailyCap as number;
  }
  if (r.acpStub === true) out.acpStub = true;
  else if (r.acpStub === false) delete out.acpStub;
  // null clears the pin (automatic); an id is kept only in a bot id's shape.
  if (r.phoneBotId === null) delete out.phoneBotId;
  else if (typeof r.phoneBotId === 'string' && BOT_ID_RE.test(r.phoneBotId)) out.phoneBotId = r.phoneBotId;
  return out;
}

export function factorySettingsPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'settings.json');
}

export class FactorySettingsStore {
  private settings: FactorySettings = cloneDefaults();
  private readonly persister: FilePersister;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => this.settings);
  }

  /** Read the file (missing → defaults). Throws on another version. */
  load(): FactorySettings {
    const raw = readVersionedFile(this.file, FACTORY_SETTINGS_VERSION);
    this.settings = raw ? mergeFactorySettings(cloneDefaults(), raw) : cloneDefaults();
    return this.get();
  }

  get(): FactorySettings {
    return mergeFactorySettings(this.settings, {});
  }

  /** Apply a patch (malformed fields are ignored) and persist. */
  async update(patch: unknown): Promise<FactorySettings> {
    this.settings = mergeFactorySettings(this.settings, patch);
    // Live from now, before the write lands: switching off stops the bots at
    // once, whether the write is slow or fails.
    notifySettingsChanged();
    await this.persister.schedule();
    return this.get();
  }
}

let current: FactorySettingsStore | null = null;
const settingsListeners = new Set<() => void>();

function notifySettingsChanged(): void {
  for (const fn of [...settingsListeners]) {
    try { fn(); } catch (err) { console.warn(`[factory] settings listener failed: ${String(err)}`); }
  }
}

/** Told after every settings write and when the live store is set or cleared.
 *  Returns the unsubscribe. */
export function onFactorySettingsChanged(fn: () => void): () => void {
  settingsListeners.add(fn);
  return () => { settingsListeners.delete(fn); };
}

/** Set by the bot runtime module's start(). */
export function setFactorySettingsStore(store: FactorySettingsStore | null): void {
  current = store;
  notifySettingsChanged();
}

/** The live settings store, or null before the factory started. */
export function getFactorySettingsStore(): FactorySettingsStore | null {
  return current;
}

/** The live settings, or the defaults (factory off) before it started. */
export function getFactorySettings(): FactorySettings {
  return current ? current.get() : cloneDefaults();
}
