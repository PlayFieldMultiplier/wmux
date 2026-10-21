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
 * The answer is the role advertised most recently (`newest`), never a union:
 * after the peer moves to a build that takes less, the role it reconnected
 * in says so, and the other role's older list no longer counts.
 *
 * Only a hint about what the other build understands: never an authorization.
 * Corrupt file: start empty (every peer unseen) and keep the original.
 */

export const PEER_FEATURES_FILE = 'peer-features.json';

/** One role's last advertisement. */
export interface PeerFeatureSeen {
  features: string[];
  /** When it was last advertised, changed or not. */
  seenAt: string;
}

export interface PeerFeatureRecord {
  /** What it advertised on its stream to this PC (it is our joiner). */
  asJoiner?: PeerFeatureSeen;
  /** What its stream `hello` advertised (this PC is its joiner). */
  asServer?: PeerFeatureSeen;
}

type Role = 'asJoiner' | 'asServer';

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

  /** The features of the role `hostId` advertised most recently; undefined when it was never seen. */
  newest(hostId: HostId): string[] | undefined {
    const rec = this.hosts[hostId];
    const latest = rec ? newestOf(rec) : undefined;
    return latest ? [...latest.features] : undefined;
  }

  /**
   * `hostId` just advertised `features` in `role`. Memory always takes it.
   * The file is written only when the answer it gives would change: the list
   * changed, or the role now answers instead of the other role's different
   * list. A failed write is logged, not thrown.
   */
  record(hostId: HostId, role: Role, features: readonly string[]): void {
    if (!isHostId(hostId)) return;
    const list = parseA2aFeatures(features.join(','));
    const prev = this.hosts[hostId];
    const mine = prev?.[role];
    const other = prev?.[role === 'asJoiner' ? 'asServer' : 'asJoiner'];
    // Strictly after the other role, so the newest is never a tie.
    const at = Math.max(this.now(), other ? Date.parse(other.seenAt) + 1 : 0);
    const changed = !mine || !sameList(mine.features, list);
    const overtakes = !changed && other !== undefined && !sameList(other.features, list) && Date.parse(other.seenAt) > Date.parse(mine.seenAt);
    this.hosts = { ...this.hosts, [hostId]: { ...prev, [role]: { features: list, seenAt: new Date(at).toISOString() } } };
    if (changed || overtakes) this.persist();
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

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function newestOf(rec: PeerFeatureRecord): PeerFeatureSeen | undefined {
  const { asJoiner: j, asServer: s } = rec;
  if (!j || !s) return j ?? s;
  return Date.parse(j.seenAt) >= Date.parse(s.seenAt) ? j : s;
}

function coerceFile(raw: unknown): PeerFeaturesFileV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !isPlainObject(raw['hosts'])) return null;
  const hosts: Record<HostId, PeerFeatureRecord> = {};
  for (const [hostId, rec] of Object.entries(raw['hosts'])) {
    if (!isHostId(hostId) || !isPlainObject(rec)) return null;
    const out: PeerFeatureRecord = {};
    for (const role of ['asJoiner', 'asServer'] as const) {
      const seen = rec[role];
      if (seen === undefined) continue;
      if (!isPlainObject(seen) || !Array.isArray(seen['features']) || !isIsoString(seen['seenAt'])) return null;
      out[role] = { features: parseA2aFeatures((seen['features'] as unknown[]).join(',')), seenAt: seen['seenAt'] };
    }
    if (!out.asJoiner && !out.asServer) return null;
    hosts[hostId] = out;
  }
  return { v: 1, hosts };
}
