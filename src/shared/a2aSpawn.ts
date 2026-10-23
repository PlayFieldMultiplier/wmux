// ─── Remote spawn: the contract ─────────────────────────────────────────────
//
// Another paired PC (A) asks this PC (B) to start a new agent, in a folder B
// allowed, with a first prompt. The request and its answer ride the existing
// A2A outbox as `link` envelopes (see `A2aRemoteEnvelope.link`):
//
//   A -> B  link.state 'spawn'          + `spawn`         (A2aSpawnRequestV1)
//   B -> A  link.state 'spawn-result'   + `spawnResult`   (A2aSpawnResultV1)
//   B -> A  link.state 'spawn-targets'  + `spawnTargets`  (A2aSpawnTargetsV1)
//
// B answers every spawn envelope at once (`ok`, or `bad-request` for one it
// cannot read) and decides later: approval and checks never hold up the
// transport. The decision travels back as its own `spawn-result` envelope,
// through B's own outbox, so it reaches A whichever side of the pair joined.
//
// Owner-gated on B: off by default, each PC opted in one by one, only the
// roots and agents B listed. The request names no path, command, flag, mode or
// environment. B's policy file is not a boundary against code running as the
// same user on B; the boundary is B's per-PC opt-in and B's approval.
//
// Pure module: no node:* imports (the renderer imports these types).

import { isAgentSlug, type AgentSlug } from './agentIdentity';
import { A2A_REMOTE_BODY_MAX, A2A_REMOTE_RECORD_V, isConsistentEndpoint, isHostId, type HostId } from './a2aRemote';
import { DEFAULT_FANOUT_WORKER_PERMISSION_MODE, isFanoutWorkerPermissionMode, type FanoutWorkerPermissionMode } from './workerLaunch';

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Longest a request may wait for B, from when it was sent. */
export const SPAWN_TTL_MAX_MS = 72 * 60 * 60 * 1000;
/** How far ahead of B's clock a request's `sentAt` may be. */
export const SPAWN_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** A request's first prompt (bytes, UTF-8). */
export const SPAWN_TEXT_MAX = A2A_REMOTE_BODY_MAX;
/** A folder's path below its root (characters). */
export const SPAWN_SUB_MAX = 512;
/** Roots and agents one policy may list. */
export const SPAWN_ROOTS_MAX = 32;
/** "Always allow" rules one policy may hold. */
export const SPAWN_RULES_MAX = 256;
/** A root's display label (characters). */
export const SPAWN_LABEL_MAX = 64;
/** A decided request is kept this long past its expiry, so a resend gets the same answer. */
export const SPAWN_REQUEST_KEEP_MS = 24 * 60 * 60 * 1000;
/** Requests B keeps (all PCs). */
export const SPAWN_REQUESTS_MAX = 1000;
/** Fixed id of the `spawn-targets` envelope: never stored as a link. */
export const SPAWN_TARGETS_LINK_ID = 'spawn-targets';

const SPAWN_ID_RE = /^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SAFE_ID_MAX = 128;

// ─── Codes ──────────────────────────────────────────────────────────────────

/**
 * What a `spawn-result` says. Only these ever reach A: never a path, an
 * errno, a message or a stack.
 *
 * `not-allowed` covers "the feature is off here" AND "this PC is not allowed"
 * on purpose: A learns nothing about B's policy from it.
 */
export const A2A_SPAWN_CODES = [
  'waiting-for-approval',
  'started',
  'not-supported',
  'not-allowed',
  'agent-not-allowed',
  'agent-not-installed',
  'folder-not-allowed',
  'expired',
  'rate-limited',
  'declined',
  'app-not-ready',
  'failed',
] as const;
export type A2aSpawnCode = (typeof A2A_SPAWN_CODES)[number];

/** A code after which nothing more comes for that request. */
export function isFinalSpawnCode(code: A2aSpawnCode): boolean {
  return code !== 'waiting-for-approval';
}

export function isSpawnCode(v: unknown): v is A2aSpawnCode {
  return typeof v === 'string' && (A2A_SPAWN_CODES as readonly string[]).includes(v);
}

// ─── Wire ───────────────────────────────────────────────────────────────────

/** A's pane that gets the replies: A's own side, named by A. */
export interface A2aSpawnFromV1 {
  kind: 'pane';
  workspaceId: string;
  paneId: string;
}

/** A -> B. Exactly these keys; anything else is refused as `bad-request`. */
export interface A2aSpawnRequestV1 {
  v: 1;
  /** `sp-<uuid>`, minted by A; also the envelope's `linkId`. */
  spawnId: string;
  agent: AgentSlug;
  /** A root B advertised, and an optional relative POSIX path below it. */
  folder: { root: string; sub?: string };
  /** The first prompt. */
  text: string;
  /** ISO; judged by B's clock. */
  expiresAt: string;
  from: A2aSpawnFromV1;
}

/** B -> A: one per decision (`waiting-for-approval` may come first). */
export interface A2aSpawnResultV1 {
  v: 1;
  spawnId: string;
  code: A2aSpawnCode;
  /** `started` only: B's new pane, B's own side. */
  endpoint?: { kind: 'pane'; workspaceId: string; paneId: string };
  /** `started` only: the link's version on B. */
  linkVersion?: number;
}

/** B -> A: what A may ask for. Ids and labels only, never a path. */
export interface A2aSpawnTargetsV1 {
  v: 1;
  /** Bumped on every change; A keeps the highest. */
  version: number;
  roots: { id: string; label: string }[];
  agents: AgentSlug[];
}

// ─── Policy (B's own file, `a2a/spawn-policy.json`) ─────────────────────────

export type A2aSpawnApproval = 'ask' | 'allow-list';
export type A2aSpawnFollowUps = 'ask' | 'direct';
export type A2aSpawnPermissionMode = FanoutWorkerPermissionMode;

export interface A2aSpawnRootV1 {
  /** Stable id A refers to (`[a-z0-9-]`, ≤ 32). */
  id: string;
  label: string;
  /** Absolute; a git repository's top level, realpath'd when it was added. */
  path: string;
}

export interface A2aSpawnRuleV1 {
  hostId: HostId;
  rootId: string;
  agent: AgentSlug;
}

export interface A2aSpawnPolicyV1 {
  v: 1;
  enabled: boolean;
  approval: A2aSpawnApproval;
  followUps: A2aSpawnFollowUps;
  /** The mode the agent runs in on this PC; never the request's. */
  permissionMode: A2aSpawnPermissionMode;
  hosts: Record<HostId, { allowed: boolean }>;
  roots: A2aSpawnRootV1[];
  agents: AgentSlug[];
  rules: A2aSpawnRuleV1[];
  /** Bumped on every save: the `spawn-targets` version. */
  version: number;
}

export const DEFAULT_SPAWN_POLICY: Readonly<A2aSpawnPolicyV1> = Object.freeze({
  v: 1,
  enabled: false,
  approval: 'ask',
  followUps: 'ask',
  permissionMode: DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  hosts: {},
  roots: [],
  agents: [],
  rules: [],
  version: 0,
});

export function defaultSpawnPolicy(): A2aSpawnPolicyV1 {
  return structuredClone({ ...DEFAULT_SPAWN_POLICY }) as A2aSpawnPolicyV1;
}

// ─── RPC (machine-local, `wmux.internal`) ───────────────────────────────────

export const A2A_SPAWN_RPC = Object.freeze({
  /** → `{ policy: A2aSpawnPolicyV1 }` */
  policyGet: 'a2a.remote.spawnPolicy.get',
  /** `{ policy }` → `{ ok: true, policy } | { ok: false, error }`; roots are checked and realpath'd here. */
  policySet: 'a2a.remote.spawnPolicy.set',
  /** → `{ requests: A2aSpawnRequestSummary[] }` (newest first, no prompt text). */
  requestsList: 'a2a.remote.spawnRequests.list',
} as const);

/** `a2a.remote.spawnPolicy.set`'s answer: the saved policy, or why it was refused. */
export type A2aSpawnPolicySetResult = { ok: true; policy: A2aSpawnPolicyV1 } | { ok: false; error: string };

/** What the UI may list about a received request: never the prompt. */
export interface A2aSpawnRequestSummary {
  hostId: HostId;
  spawnId: string;
  agent: AgentSlug;
  rootId: string;
  state: 'pending' | 'decided';
  code?: A2aSpawnCode;
  receivedAt: string;
  expiresAt: string;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function safeId(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return typeof v === 'string' && v.length > 0 && v.length <= SAFE_ID_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

export function isSpawnId(v: unknown): v is string {
  return typeof v === 'string' && SPAWN_ID_RE.test(v);
}

export function isSpawnRootId(v: unknown): v is string {
  return typeof v === 'string' && ROOT_ID_RE.test(v);
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The path below a root, normalized: '' for the root itself, else segments
 * joined by '/'. Null for anything that could leave the root or is not plain:
 * absolute, a drive or UNC prefix, a `..` segment, a backslash, NUL or another
 * control character, or too long. `.` and empty segments are dropped.
 */
export function normalizeSpawnSub(sub: unknown): string | null {
  if (sub === undefined) return '';
  if (typeof sub !== 'string' || sub.length > SPAWN_SUB_MAX) return null;
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(sub)) return null;
  if (sub.startsWith('/') || /^[A-Za-z]:/.test(sub)) return null;
  const parts = sub.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** A request body, strictly; null when it is not exactly one. */
export function parseSpawnRequest(raw: unknown): A2aSpawnRequestV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'spawnId', 'agent', 'folder', 'text', 'expiresAt', 'from'])) return null;
  if (raw['v'] !== 1 || !isSpawnId(raw['spawnId']) || !isAgentSlug(raw['agent'])) return null;
  const folder = raw['folder'];
  if (!isPlain(folder) || !onlyKeys(folder, ['root', 'sub']) || !isSpawnRootId(folder['root'])) return null;
  const sub = normalizeSpawnSub(folder['sub']);
  if (sub === null) return null;
  const text = raw['text'];
  if (typeof text !== 'string' || !text.trim() || utf8Bytes(text) > SPAWN_TEXT_MAX) return null;
  const expiresAt = raw['expiresAt'];
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
  const from = raw['from'];
  if (!isPlain(from) || !onlyKeys(from, ['kind', 'workspaceId', 'paneId']) || from['kind'] !== 'pane') return null;
  if (!isConsistentEndpoint(from) || !safeId(from['workspaceId']) || !safeId(from['paneId'])) return null;
  return {
    v: 1,
    spawnId: raw['spawnId'] as string,
    agent: raw['agent'] as AgentSlug,
    folder: { root: folder['root'] as string, ...(sub ? { sub } : {}) },
    text,
    expiresAt,
    from: { kind: 'pane', workspaceId: from['workspaceId'] as string, paneId: from['paneId'] as string },
  };
}

/**
 * Whether a request is inside its time window by B's clock: not sent from the
 * future (past the allowed skew), not living longer than 72 h from either its
 * send time or now, and not expired.
 */
export function spawnClockOk(sentAt: string, expiresAt: string, now: number): boolean {
  const sent = Date.parse(sentAt);
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(sent) || Number.isNaN(expires)) return false;
  if (sent > now + SPAWN_CLOCK_SKEW_MS) return false;
  if (expires > now + SPAWN_TTL_MAX_MS || expires > sent + SPAWN_TTL_MAX_MS) return false;
  return now <= expires;
}

export function parseSpawnResult(raw: unknown): A2aSpawnResultV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'spawnId', 'code', 'endpoint', 'linkVersion'])) return null;
  if (raw['v'] !== 1 || !isSpawnId(raw['spawnId']) || !isSpawnCode(raw['code'])) return null;
  const code = raw['code'];
  const endpoint = raw['endpoint'];
  const linkVersion = raw['linkVersion'];
  if (code !== 'started') {
    if (endpoint !== undefined || linkVersion !== undefined) return null;
    return { v: 1, spawnId: raw['spawnId'] as string, code };
  }
  if (!isPlain(endpoint) || !onlyKeys(endpoint, ['kind', 'workspaceId', 'paneId']) || endpoint['kind'] !== 'pane') return null;
  if (!safeId(endpoint['workspaceId']) || !safeId(endpoint['paneId'])) return null;
  if (typeof linkVersion !== 'number' || !Number.isInteger(linkVersion) || linkVersion < 1) return null;
  return {
    v: 1,
    spawnId: raw['spawnId'] as string,
    code,
    endpoint: { kind: 'pane', workspaceId: endpoint['workspaceId'] as string, paneId: endpoint['paneId'] as string },
    linkVersion,
  };
}

export function parseSpawnTargets(raw: unknown): A2aSpawnTargetsV1 | null {
  if (!isPlain(raw) || !onlyKeys(raw, ['v', 'version', 'roots', 'agents'])) return null;
  const version = raw['version'];
  if (raw['v'] !== 1 || typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  const roots = raw['roots'];
  const agents = raw['agents'];
  if (!Array.isArray(roots) || roots.length > SPAWN_ROOTS_MAX || !Array.isArray(agents) || agents.length > SPAWN_ROOTS_MAX) return null;
  const cleanRoots: A2aSpawnTargetsV1['roots'] = [];
  for (const r of roots) {
    if (!isPlain(r) || !onlyKeys(r, ['id', 'label']) || !isSpawnRootId(r['id']) || !isLabel(r['label'])) return null;
    cleanRoots.push({ id: r['id'] as string, label: r['label'] as string });
  }
  if (!agents.every(isAgentSlug)) return null;
  return { v: 1, version, roots: cleanRoots, agents: [...new Set(agents as AgentSlug[])] };
}

function isLabel(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return typeof v === 'string' && v.trim().length > 0 && v.length <= SPAWN_LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(v);
}

/**
 * A policy from disk or from the UI, every field checked; null when it is not
 * one. Unknown agents, hosts, rules and malformed roots make the whole policy
 * invalid rather than being dropped, so a save never silently narrows.
 */
export function coerceSpawnPolicy(raw: unknown): A2aSpawnPolicyV1 | null {
  if (!isPlain(raw) || raw['v'] !== A2A_REMOTE_RECORD_V) return null;
  const { enabled, approval, followUps, permissionMode, hosts, roots, agents, rules, version } = raw;
  if (typeof enabled !== 'boolean') return null;
  if (approval !== 'ask' && approval !== 'allow-list') return null;
  if (followUps !== 'ask' && followUps !== 'direct') return null;
  if (!isFanoutWorkerPermissionMode(permissionMode)) return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null;
  if (!isPlain(hosts)) return null;
  const cleanHosts: Record<HostId, { allowed: boolean }> = {};
  for (const [hostId, h] of Object.entries(hosts)) {
    if (!isHostId(hostId) || !isPlain(h) || typeof h['allowed'] !== 'boolean') return null;
    cleanHosts[hostId] = { allowed: h['allowed'] };
  }
  if (!Array.isArray(roots) || roots.length > SPAWN_ROOTS_MAX) return null;
  const cleanRoots: A2aSpawnRootV1[] = [];
  for (const r of roots) {
    if (!isPlain(r) || !isSpawnRootId(r['id']) || !isLabel(r['label']) || typeof r['path'] !== 'string' || !r['path']) return null;
    if (cleanRoots.some((c) => c.id === r['id'])) return null;
    cleanRoots.push({ id: r['id'] as string, label: r['label'] as string, path: r['path'] as string });
  }
  if (!Array.isArray(agents) || agents.length > SPAWN_ROOTS_MAX || !agents.every(isAgentSlug)) return null;
  if (!Array.isArray(rules) || rules.length > SPAWN_RULES_MAX) return null;
  const cleanRules: A2aSpawnRuleV1[] = [];
  for (const r of rules) {
    if (!isPlain(r) || !isHostId(r['hostId']) || !isSpawnRootId(r['rootId']) || !isAgentSlug(r['agent'])) return null;
    cleanRules.push({ hostId: r['hostId'], rootId: r['rootId'] as string, agent: r['agent'] });
  }
  return {
    v: 1,
    enabled,
    approval,
    followUps,
    permissionMode,
    hosts: cleanHosts,
    roots: cleanRoots,
    agents: [...new Set(agents as AgentSlug[])],
    rules: cleanRules,
    version,
  };
}

/** Whether `hostId` may ask at all: the feature on and that PC opted in. */
export function spawnHostAllowed(policy: A2aSpawnPolicyV1, hostId: HostId): boolean {
  return policy.enabled && policy.hosts[hostId]?.allowed === true;
}

/** What `hostId` may ask for, or null when it may not ask at all. */
export function spawnTargetsFor(policy: A2aSpawnPolicyV1, hostId: HostId): A2aSpawnTargetsV1 | null {
  if (!spawnHostAllowed(policy, hostId)) return null;
  return {
    v: 1,
    version: policy.version,
    roots: policy.roots.map((r) => ({ id: r.id, label: r.label })),
    agents: [...policy.agents],
  };
}
