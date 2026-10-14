import * as fs from 'fs';
import { writeFileAtomic } from './atomicWrite';
import type { SurfaceProfile } from '../../../shared/tokenUsage/profileTypes';

export interface RemovedHookEntry {
  id: string;
  definition: unknown;
  originPath?: string;
}

export interface SurfacesStoreData {
  version: number;
  intents?: Record<string, Record<string, boolean>>;
  removedHooks?: Record<string, RemovedHookEntry[]>;
  profiles?: SurfaceProfile[];
  [key: string]: unknown;
}

export interface SurfacesStoreDeps {
  readFile?: (path: string, encoding: 'utf8') => string;
}

export interface SurfacesStoreSaveOptions {
  replaceCorrupt?: boolean;
}

function isValidProfile(item: unknown): item is SurfaceProfile {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const p = item as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id.trim()) return false;
  if (typeof p.name !== 'string') return false;
  const trimmedName = p.name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 40) return false;
  if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) return false;
  if (!p.providers || typeof p.providers !== 'object' || Array.isArray(p.providers)) return false;
  const validProviders = new Set(['claude', 'codex', 'agy']);
  for (const [k, v] of Object.entries(p.providers as Record<string, unknown>)) {
    if (!validProviders.has(k)) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const provState = v as Record<string, unknown>;
    if (!Array.isArray(provState.knownItemIds) || !provState.knownItemIds.every((id) => typeof id === 'string')) {
      return false;
    }
    if (!Array.isArray(provState.disabledItemIds) || !provState.disabledItemIds.every((id) => typeof id === 'string')) {
      return false;
    }
  }
  return true;
}

type StoreMutation =
  | { type: 'recordIntent'; provider: string; itemId: string; wantedEnabled: boolean }
  | { type: 'addRemovedHook'; provider: string; hook: RemovedHookEntry }
  | { type: 'takeRemovedHook'; provider: string; id: string }
  | { type: 'addProfile'; profile: SurfaceProfile }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setProfiles'; profiles: SurfaceProfile[] };

const KNOWN_KEYS = new Set(['version', 'intents', 'removedHooks', 'profiles']);

/** The store content a save writes, before the version key. */
interface StoreContent {
  unknownKeys: Record<string, unknown>;
  intents: Record<string, Record<string, boolean>>;
  removedHooks: Record<string, RemovedHookEntry[]>;
  profiles: SurfaceProfile[];
  hasProfilesKey: boolean;
}

/** The parsed store object, or why the text is not one. */
function parseStoreObject(raw: string): SurfacesStoreData | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return (err as Error).message;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'content is not a JSON object';
  }
  return parsed as SurfacesStoreData;
}

/** The content of a version 1 file; entries of the wrong shape are left out. */
function contentFromDisk(
  data: SurfacesStoreData,
  unknownKeys: Record<string, unknown>,
  hasProfilesKey: boolean,
): StoreContent {
  for (const [key, val] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) {
      unknownKeys[key] = val;
    }
  }
  return {
    unknownKeys,
    intents: diskIntents(data.intents),
    removedHooks: diskRemovedHooks(data.removedHooks),
    profiles: diskProfiles(data.profiles),
    hasProfilesKey: hasProfilesKey || 'profiles' in data,
  };
}

function diskIntents(value: unknown): Record<string, Record<string, boolean>> {
  const intents: Record<string, Record<string, boolean>> = {};
  if (!value || typeof value !== 'object') return intents;
  for (const [provider, items] of Object.entries(value)) {
    if (items && typeof items === 'object') {
      intents[provider] = { ...(items as Record<string, boolean>) };
    }
  }
  return intents;
}

function diskRemovedHooks(value: unknown): Record<string, RemovedHookEntry[]> {
  const removedHooks: Record<string, RemovedHookEntry[]> = {};
  if (!value || typeof value !== 'object') return removedHooks;
  for (const [provider, hooks] of Object.entries(value)) {
    if (Array.isArray(hooks)) {
      removedHooks[provider] = [...hooks];
    }
  }
  return removedHooks;
}

/** Valid profiles, names trimmed, at most 50. */
function diskProfiles(value: unknown): SurfaceProfile[] {
  const profiles: SurfaceProfile[] = [];
  if (!Array.isArray(value)) return profiles;
  for (const item of value) {
    if (isValidProfile(item) && profiles.length < 50) {
      profiles.push({ ...item, name: item.name.trim() });
    }
  }
  return profiles;
}

export class SurfacesStore {
  readonly filePath: string;
  readonly warnings: string[] = [];

  private intents: Record<string, Record<string, boolean>> = {};
  private removedHooksStore: Record<string, RemovedHookEntry[]> = {};
  private profilesList: SurfaceProfile[] = [];
  private unknownKeys: Record<string, unknown> = {};
  private hasProfilesKey = false;
  private hasRefusedVersion = false;
  private mutations: StoreMutation[] = [];

  readonly removedHooks = {
    add: (provider: string, hook: RemovedHookEntry): void => {
      if (!this.removedHooksStore[provider]) {
        this.removedHooksStore[provider] = [];
      }
      const list = this.removedHooksStore[provider];
      const idx = list.findIndex((h) => h.id === hook.id);
      if (idx !== -1) {
        list[idx] = hook;
      } else {
        list.push(hook);
      }
      this.mutations.push({ type: 'addRemovedHook', provider, hook: { ...hook } });
    },

    take: (provider: string, id: string): RemovedHookEntry | undefined => {
      const list = this.removedHooksStore[provider];
      if (!list) return undefined;
      const idx = list.findIndex((h) => h.id === id);
      if (idx === -1) return undefined;
      const [item] = list.splice(idx, 1);
      if (item) {
        this.mutations.push({ type: 'takeRemovedHook', provider, id });
      }
      return item;
    },

    get: (provider: string, id: string): RemovedHookEntry | undefined => {
      const list = this.removedHooksStore[provider];
      return list?.find((h) => h.id === id);
    },

    list: (provider: string): RemovedHookEntry[] => {
      return [...(this.removedHooksStore[provider] ?? [])];
    },
  };

  readonly profiles = {
    list: (): SurfaceProfile[] => [...this.profilesList],
    get: (id: string): SurfaceProfile | undefined => this.profilesList.find((p) => p.id === id),
    getByName: (name: string): SurfaceProfile | undefined => {
      const lower = name.trim().toLowerCase();
      return this.profilesList.find((p) => p.name.trim().toLowerCase() === lower);
    },
    add: (profile: SurfaceProfile): void => {
      const trimmedName = profile.name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 40) {
        throw new Error('Profile name must be between 1 and 40 characters');
      }
      const existing = this.profilesList.find(
        (p) => p.id !== profile.id && p.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (existing) {
        throw new Error('A profile with this name already exists');
      }
      const idx = this.profilesList.findIndex((p) => p.id === profile.id);
      if (idx !== -1) {
        this.profilesList[idx] = { ...profile, name: trimmedName };
      } else {
        if (this.profilesList.length >= 50) {
          throw new Error('Maximum number of profiles (50) reached');
        }
        this.profilesList.push({ ...profile, name: trimmedName });
      }
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'addProfile', profile: { ...profile, name: trimmedName } });
    },
    delete: (id: string): boolean => {
      const idx = this.profilesList.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      this.profilesList.splice(idx, 1);
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'deleteProfile', id });
      return true;
    },
    set: (profiles: SurfaceProfile[]): void => {
      if (profiles.length > 50) {
        throw new Error('Maximum number of profiles (50) reached');
      }
      this.profilesList = [...profiles];
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'setProfiles', profiles: [...profiles] });
    },
  };

  private readonly readFile: (path: string, encoding: 'utf8') => string;

  constructor(filePath: string, deps?: SurfacesStoreDeps) {
    this.filePath = filePath;
    this.readFile = deps?.readFile ?? ((p, enc) => fs.readFileSync(p, enc));
  }

  load(): void {
    this.intents = {};
    this.removedHooksStore = {};
    this.profilesList = [];
    this.unknownKeys = {};
    this.hasProfilesKey = false;
    this.hasRefusedVersion = false;
    this.mutations = [];

    if (!fs.existsSync(this.filePath)) {
      return;
    }

    let parsed: unknown;
    try {
      const content = this.readFile(this.filePath, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      this.warnings.push(`Corrupt surfaces store file: ${(err as Error).message}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warnings.push('Corrupt surfaces store: content is not a JSON object');
      return;
    }

    const data = parsed as SurfacesStoreData;
    if (typeof data.version !== 'number' || data.version !== 1) {
      this.warnings.push(`Unknown or unsupported surfaces store version: ${data.version}`);
      this.hasRefusedVersion = true;
      return;
    }

    for (const [key, val] of Object.entries(data)) {
      if (!KNOWN_KEYS.has(key)) {
        this.unknownKeys[key] = val;
      }
    }

    if (data.intents && typeof data.intents === 'object') {
      this.intents = data.intents;
    }
    if (data.removedHooks && typeof data.removedHooks === 'object') {
      this.removedHooksStore = data.removedHooks;
    }

    if ('profiles' in data) {
      this.hasProfilesKey = true;
      if (!Array.isArray(data.profiles)) {
        this.warnings.push('Corrupt surfaces store: profiles is not an array');
      } else {
        for (const item of data.profiles) {
          if (isValidProfile(item)) {
            if (this.profilesList.length < 50) {
              this.profilesList.push({ ...item, name: item.name.trim() });
            } else {
              this.warnings.push('Profile limit exceeded: maximum 50 profiles stored');
            }
          } else {
            this.warnings.push('Dropping corrupt or invalid profile entry');
          }
        }
      }
    }
  }

  save(options?: SurfacesStoreSaveOptions): void {
    if (this.hasRefusedVersion) {
      throw this.refusal('Refusing to save: newer version file exists on disk');
    }

    // This instance's changes are replayed on the file as it is now, so another process's writes survive.
    const next = this.readForSave(options);
    for (const mutation of this.mutations) {
      this.replay(next, mutation);
    }

    const payload: SurfacesStoreData = {
      ...next.unknownKeys,
      version: 1,
      intents: next.intents,
      removedHooks: next.removedHooks,
    };

    if (next.hasProfilesKey || next.profiles.length > 0) {
      payload.profiles = next.profiles;
    }

    // Cross-process file race remains a known limit.
    writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2) + '\n');

    this.intents = next.intents;
    this.removedHooksStore = next.removedHooks;
    this.profilesList = next.profiles;
    this.unknownKeys = next.unknownKeys;
    this.hasProfilesKey = next.hasProfilesKey;
    this.mutations = [];
  }

  /** Records a refusal as a warning and returns the error to throw. */
  private refusal(msg: string): Error {
    this.warnings.push(msg);
    return new Error(msg);
  }

  /**
   * What a save starts from: the file as it is now, or this instance's own state when there is no file, or
   * when the file is corrupt and the caller asked to replace it.
   */
  private readForSave(options?: SurfacesStoreSaveOptions): StoreContent {
    if (!fs.existsSync(this.filePath)) {
      return this.ownContent();
    }
    let raw: string;
    try {
      raw = this.readFile(this.filePath, 'utf8');
    } catch (err) {
      throw this.refusal(`Refusing to save: cannot read existing store file: ${(err as Error).message}`);
    }
    const parsed = parseStoreObject(raw);
    if (typeof parsed === 'string') {
      if (!options?.replaceCorrupt) {
        throw this.refusal(`Refusing to save: corrupt surfaces store file on disk: ${parsed}`);
      }
      return this.ownContent();
    }
    this.checkDiskVersion(parsed.version);
    return contentFromDisk(parsed, { ...this.unknownKeys }, this.hasProfilesKey);
  }

  private ownContent(): StoreContent {
    const intents: Record<string, Record<string, boolean>> = {};
    for (const [provider, items] of Object.entries(this.intents)) {
      intents[provider] = { ...items };
    }
    const removedHooks: Record<string, RemovedHookEntry[]> = {};
    for (const [provider, hooks] of Object.entries(this.removedHooksStore)) {
      removedHooks[provider] = [...hooks];
    }
    return {
      unknownKeys: { ...this.unknownKeys },
      intents,
      removedHooks,
      profiles: [...this.profilesList],
      hasProfilesKey: this.hasProfilesKey,
    };
  }

  private checkDiskVersion(version: unknown): void {
    if (typeof version === 'number' && version > 1) {
      this.hasRefusedVersion = true;
      throw this.refusal(`Refusing to save: newer version ${version} detected on disk`);
    }
    if (typeof version !== 'number' || version !== 1) {
      this.hasRefusedVersion = true;
      throw this.refusal(`Refusing to save: unsupported surfaces store version: ${version}`);
    }
  }

  /** Applies one recorded change of this instance to the content about to be written. */
  private replay(next: StoreContent, mutation: StoreMutation): void {
    switch (mutation.type) {
      case 'recordIntent': {
        if (!next.intents[mutation.provider]) {
          next.intents[mutation.provider] = {};
        }
        next.intents[mutation.provider][mutation.itemId] = mutation.wantedEnabled;
        break;
      }
      case 'addRemovedHook': {
        if (!next.removedHooks[mutation.provider]) {
          next.removedHooks[mutation.provider] = [];
        }
        const list = next.removedHooks[mutation.provider];
        const idx = list.findIndex((h) => h.id === mutation.hook.id);
        if (idx !== -1) {
          list[idx] = mutation.hook;
        } else {
          list.push(mutation.hook);
        }
        break;
      }
      case 'takeRemovedHook': {
        const list = next.removedHooks[mutation.provider];
        const idx = list ? list.findIndex((h) => h.id === mutation.id) : -1;
        if (idx !== -1) {
          list.splice(idx, 1);
        }
        break;
      }
      case 'addProfile':
        this.replayAddProfile(next, mutation.profile);
        break;
      case 'deleteProfile': {
        next.hasProfilesKey = true;
        const idx = next.profiles.findIndex((p) => p.id === mutation.id);
        if (idx !== -1) {
          next.profiles.splice(idx, 1);
        }
        break;
      }
      case 'setProfiles': {
        next.hasProfilesKey = true;
        next.profiles = [...mutation.profiles];
        break;
      }
    }
  }

  /** The profile checks run again against the file: another process may have taken the name or the last slot. */
  private replayAddProfile(next: StoreContent, profile: SurfaceProfile): void {
    next.hasProfilesKey = true;
    const trimmedName = profile.name.trim();
    const lowerName = trimmedName.toLowerCase();
    const existingWithName = next.profiles.find(
      (p) => p.id !== profile.id && p.name.trim().toLowerCase() === lowerName,
    );
    if (existingWithName) {
      throw this.refusal('A profile with this name already exists');
    }
    const idx = next.profiles.findIndex((p) => p.id === profile.id);
    if (idx !== -1) {
      next.profiles[idx] = { ...profile, name: trimmedName };
    } else {
      if (next.profiles.length >= 50) {
        throw this.refusal('Maximum number of profiles (50) reached');
      }
      next.profiles.push({ ...profile, name: trimmedName });
    }
  }

  recordIntent(provider: string, itemId: string, wantedEnabled: boolean): void {
    if (!this.intents[provider]) {
      this.intents[provider] = {};
    }
    this.intents[provider][itemId] = wantedEnabled;
    this.mutations.push({ type: 'recordIntent', provider, itemId, wantedEnabled });
  }

  getIntent(provider: string, itemId: string): boolean | undefined {
    return this.intents[provider]?.[itemId];
  }

  reconcile(
    provider: string,
    currentItemIds: string[],
  ): { newItems: string[]; removedItems: string[] } {
    const recordedMap = this.intents[provider] ?? {};
    const recordedIds = Object.keys(recordedMap);
    const recordedSet = new Set(recordedIds);
    const currentSet = new Set(currentItemIds);

    const newItems = currentItemIds.filter((id) => !recordedSet.has(id));
    const removedItems = recordedIds.filter((id) => !currentSet.has(id));

    return { newItems, removedItems };
  }

  listProfiles(): SurfaceProfile[] {
    return this.profiles.list();
  }

  getProfile(id: string): SurfaceProfile | undefined {
    return this.profiles.get(id);
  }

  addProfile(profile: SurfaceProfile): void {
    this.profiles.add(profile);
  }

  saveProfile(profile: SurfaceProfile): void {
    this.profiles.add(profile);
  }

  deleteProfile(id: string): boolean {
    return this.profiles.delete(id);
  }
}
