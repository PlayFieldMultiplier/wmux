import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isHostId, parseA2aFeatures, type HostId } from '../../shared/a2aRemote';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * What each paired PC last advertised (`peer-features.json`), per role: as a
 * joiner of this PC (its stream's `A2A_FEATURES_HEADER`) and as a server this
 * PC joined (its stream's `hello`). The live values are in memory and gone
 * after a daemon restart until the peer reconnects; a sender that must know
 * whether the peer takes something (images) reads the last seen ones here.
 *
 * Only a hint about what the other build understands: never an authorization.
 * Corrupt file: start empty (every peer unseen) and keep the original.
 */

export const PEER_FEATURES_FILE = 'peer-features.json';

export interface PeerFeatureRecord {
  /** What it advertised on its stream to this PC (it is our joiner). */
  asJoiner?: string[];
  /** What its stream `hello` advertised (this PC is its joiner). */
  asServer?: string[];
  changedAt: string;
}

interface PeerFeaturesFileV1 {
  v: 1;
  hosts: Record<HostId, PeerFeatureRecord>;
}

export interface PeerFeatureStoreOptions {
  /** `<wmux data dir>/a2a/` */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
}

export class PeerFeatureStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private hosts: Record<HostId, PeerFeatureRecord> = {};
  private writable = true;

  constructor(opts: PeerFeatureStoreOptions) {
    this.filePath = path.join(opts.dir, PEER_FEATURES_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: PEER_FEATURES_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'every paired PC counts as not seen yet',
    });
    this.writable = writable;
    if (value) this.hosts = value.hosts;
  }

  /** Both roles' last seen features of `hostId`, or undefined when it was never seen. */
  get(hostId: HostId): PeerFeatureRecord | undefined {
    const rec = this.hosts[hostId];
    return rec ? structuredClone(rec) : undefined;
  }

  /** `hostId` just advertised `features` in `role`. Written only when it changed; a failed write is logged, not thrown. */
  record(hostId: HostId, role: 'asJoiner' | 'asServer', features: readonly string[]): void {
    if (!isHostId(hostId)) return;
    const list = parseA2aFeatures(features.join(','));
    const prev = this.hosts[hostId];
    if (prev && sameList(prev[role], list)) return;
    // Memory always takes it (it is what the peer said); a failed write is
    // caught up by the next change.
    this.hosts = { ...this.hosts, [hostId]: { ...prev, [role]: list, changedAt: new Date(this.now()).toISOString() } };
    this.persist();
  }

  /** The pairing with `hostId` ended: forget it. */
  forget(hostId: HostId): void {
    if (!this.hosts[hostId]) return;
    const rest = { ...this.hosts };
    delete rest[hostId];
    this.hosts = rest;
    this.persist();
  }

  private persist(): void {
    if (!this.writable) {
      this.log('warn', `[a2a-remote] ${storeUnavailable(PEER_FEATURES_FILE).message}`);
      return;
    }
    try {
      this.write(this.filePath, { v: 1, hosts: this.hosts } satisfies PeerFeaturesFileV1);
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('warn', `[a2a-remote] ${PEER_FEATURES_FILE} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
}

function coerceFile(raw: unknown): PeerFeaturesFileV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !isPlainObject(raw['hosts'])) return null;
  const hosts: Record<HostId, PeerFeatureRecord> = {};
  for (const [hostId, rec] of Object.entries(raw['hosts'])) {
    if (!isHostId(hostId) || !isPlainObject(rec) || !isIsoString(rec['changedAt'])) return null;
    const out: PeerFeatureRecord = { changedAt: rec['changedAt'] };
    for (const role of ['asJoiner', 'asServer'] as const) {
      if (rec[role] === undefined) continue;
      if (!Array.isArray(rec[role])) return null;
      out[role] = parseA2aFeatures((rec[role] as unknown[]).join(','));
    }
    hosts[hostId] = out;
  }
  return { v: 1, hosts };
}
