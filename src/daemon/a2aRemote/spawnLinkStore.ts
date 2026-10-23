import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import { isSpawnId, isSpawnRootId, spawnLinkId } from '../../shared/a2aSpawn';
import { isIsoString, isPlainObject, isSafeId, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * The links a remote spawn made on this PC (`spawn-links.json`), next to
 * `links.json` rather than inside it: an older build reads that file whole
 * and would refuse one record with a field it does not know.
 *
 * A link listed here gets the spawn rules for as long as it lives: its
 * outgoing text is redacted, it carries no images either way, and with
 * `followUps: 'ask'` each later instruction waits for its card. When the
 * link ends, the exposure the start added is put back and the record goes.
 */

export const SPAWN_LINKS_FILE = 'spawn-links.json';
/** Records kept at most (each is a started agent; the live caps keep this far lower). */
const SPAWN_LINKS_MAX = 1000;

export interface SpawnLinkRecordV1 {
  v: 1;
  linkId: string;
  hostId: HostId;
  spawnId: string;
  workspaceId: string;
  paneId: string;
  agent: AgentSlug;
  rootId: string;
  /** The folder the agent was started for, as resolved here (display, on this PC only). */
  folder: string;
  /** The start showed this pane to that PC (it was not shown already): put it back when the link ends. */
  addedExposure: boolean;
  /** …and with it the pane's workspace. */
  addedWorkspace: boolean;
  startedAt: string;
}

export interface SpawnLinkStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class SpawnLinkStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly records = new Map<string, SpawnLinkRecordV1>();
  private writable: boolean;

  constructor(opts: SpawnLinkStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_LINKS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_LINKS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['links']) ? raw['links'] : null),
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'no link is known to come from a remote start',
    });
    this.writable = loaded.writable;
    for (const r of loaded.value ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(rec.linkId, rec);
      else this.log('warn', `[a2a-remote] ${SPAWN_LINKS_FILE}: a record this build cannot read was skipped`);
    }
  }

  get(linkId: string): SpawnLinkRecordV1 | undefined {
    const rec = this.records.get(linkId);
    return rec ? structuredClone(rec) : undefined;
  }

  has(linkId: string): boolean {
    return this.records.has(linkId);
  }

  list(): SpawnLinkRecordV1[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  /** Written before the link exists, so a link a start made is never without its rules. */
  add(rec: SpawnLinkRecordV1): void {
    if (!this.writable) throw storeUnavailable(SPAWN_LINKS_FILE);
    const clean = coerceRecord(rec);
    if (!clean) throw new Error('spawn link: invalid record');
    const next = new Map(this.records);
    next.set(clean.linkId, clean);
    while (next.size > SPAWN_LINKS_MAX) next.delete(next.keys().next().value as string);
    this.save(next);
  }

  remove(linkId: string): void {
    if (!this.records.has(linkId)) return;
    if (!this.writable) throw storeUnavailable(SPAWN_LINKS_FILE);
    const next = new Map(this.records);
    next.delete(linkId);
    this.save(next);
  }

  /** Write first, then make it the live set: a failed write changes nothing. */
  private save(next: Map<string, SpawnLinkRecordV1>): void {
    this.write(this.filePath, { v: 1, links: [...next.values()] });
    this.scheduleHarden(this.filePath);
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
  }
}

function coerceRecord(raw: unknown): SpawnLinkRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { linkId, hostId, spawnId, workspaceId, paneId, agent, rootId, folder, addedExposure, addedWorkspace, startedAt } = raw;
  if (!isSpawnId(spawnId) || linkId !== spawnLinkId(spawnId) || !isHostId(hostId)) return null;
  if (!isSafeId(workspaceId) || !isSafeId(paneId) || !isAgentSlug(agent) || !isSpawnRootId(rootId)) return null;
  if (typeof folder !== 'string' || folder.length > 4096) return null;
  if (typeof addedExposure !== 'boolean' || typeof addedWorkspace !== 'boolean' || !isIsoString(startedAt)) return null;
  return { v: 1, linkId, hostId, spawnId, workspaceId, paneId, agent, rootId, folder, addedExposure, addedWorkspace, startedAt };
}
