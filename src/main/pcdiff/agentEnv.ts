// This PC's agent environment summary (shared/agentEnvSummary.ts), and the
// comparison with the paired PCs' (`pc.envDiff`). Read-only.
//
// Local facts come from what main already reads: the surfaces inventory
// (claude, codex, agy: CLI version, skills, MCP servers) and, for agents that
// inventory does not cover, the version in the installed package's
// package.json, read from disk (running `gemini --version` writes into
// ~/.gemini). The global instruction files are hashed byte for byte. Kept for
// CACHE_MS: the inventory has no change signal.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteHost } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import type { ProviderInventory, SurfaceProviderId } from '../../shared/tokenUsage/surfaceTypes';
import { AGENT_ENV_LIMITS, AGENT_ENV_ROUTE, buildAgentEnvSummary, parseAgentEnvSummary, type AgentEnvAgent, type AgentEnvInstruction, type AgentEnvSummary } from '../../shared/agentEnvSummary';
import { diffAgentEnvs, type AgentEnvDiff, type AgentEnvHost } from '../../shared/agentEnvDiff';
import { resolveOnPath } from '../factory/botEngines';
import { readBoundedJson } from '../remote/readBoundedJson';
import { readInventory } from '../surfaces/inventory';

export const AGENT_ENV_CACHE_MS = 60_000;
const REMOTE_TIMEOUT_MS = 8_000;
const INVENTORY_PROVIDERS: readonly SurfaceProviderId[] = ['claude', 'codex', 'agy'];
/** Agents outside the inventory, by command and the npm package that installs it. */
const PACKAGE_AGENTS: ReadonlyArray<{ agent: string; command: string; pkg: string }> = [
  { agent: 'gemini', command: 'gemini', pkg: '@google/gemini-cli' },
  { agent: 'qwen', command: 'qwen', pkg: '@qwen-code/qwen-code' },
];
/** The global instruction files, home-relative. */
export const INSTRUCTION_FILES: readonly string[] = [
  '.claude/CLAUDE.md',
  '.codex/AGENTS.md',
  '.gemini/GEMINI.md',
  '.qwen/QWEN.md',
];

export interface AgentEnvDeps {
  wmuxVersion: string;
  homeDir?: string;
  readInventory?: (provider: SurfaceProviderId) => Promise<ProviderInventory>;
  /** The executable a command runs, or null. */
  resolveCommand?: (command: string) => string | null;
  readFile?: (p: string) => Promise<Buffer>;
  realpath?: (p: string) => Promise<string>;
}

async function packageVersion(executable: string, pkg: string, deps: Required<Pick<AgentEnvDeps, 'readFile' | 'realpath'>>): Promise<string | null> {
  const read = async (dir: string): Promise<string | null> => {
    try {
      const json = JSON.parse((await deps.readFile(path.join(dir, 'package.json'))).toString('utf8')) as { name?: unknown; version?: unknown };
      return json.name === pkg && typeof json.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  };
  // An npm bin is a link into the package (macOS, Linux) or a shim next to
  // the global node_modules (Windows, or a copied bin).
  const binDir = path.dirname(executable);
  const candidates = [path.join(binDir, 'node_modules', pkg), path.join(binDir, '..', 'lib', 'node_modules', pkg)];
  try {
    let dir = path.dirname(await deps.realpath(executable));
    for (let i = 0; i < 6; i++) {
      candidates.unshift(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable: the shim layouts only */
  }
  for (const dir of candidates) {
    const version = await read(dir);
    if (version) return version;
  }
  return null;
}

/** SHA-256 of a file's bytes exactly as stored; null when it does not exist or cannot be read. */
async function hashFile(p: string, readFile: (p: string) => Promise<Buffer>): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(p)).digest('hex');
  } catch {
    return null;
  }
}

export async function collectAgentEnvSummary(deps: AgentEnvDeps): Promise<AgentEnvSummary> {
  const home = deps.homeDir ?? os.homedir();
  const readInv = deps.readInventory ?? ((provider: SurfaceProviderId) => readInventory(provider));
  const io = { readFile: deps.readFile ?? ((p: string) => fs.readFile(p)), realpath: deps.realpath ?? ((p: string) => fs.realpath(p)) };
  const resolve = deps.resolveCommand ?? ((command: string) => resolveOnPath(command));
  const inventories = (await Promise.all(INVENTORY_PROVIDERS.map((p) => readInv(p).catch(() => null))))
    .filter((inv): inv is ProviderInventory => inv !== null);
  const versions: AgentEnvAgent[] = await Promise.all(PACKAGE_AGENTS.map(async ({ agent, command, pkg }) => {
    const executable = resolve(command);
    return { agent, version: executable ? await packageVersion(executable, pkg, io) : null };
  }));
  const instructions: AgentEnvInstruction[] = await Promise.all(INSTRUCTION_FILES.map(async (rel) => ({
    file: `~/${rel}`,
    sha256: await hashFile(path.join(home, ...rel.split('/')), io.readFile),
  })));
  return buildAgentEnvSummary({ wmuxVersion: deps.wmuxVersion, inventories, versions, instructions });
}

let cached: { at: number; value: Promise<AgentEnvSummary> } | null = null;

/** This PC's summary, read at most once per AGENT_ENV_CACHE_MS. A failed read is not kept. */
export function cachedAgentEnvSummary(deps: AgentEnvDeps, now = Date.now()): Promise<AgentEnvSummary> {
  if (cached && now - cached.at < AGENT_ENV_CACHE_MS) return cached.value;
  const value = collectAgentEnvSummary(deps);
  const entry = { at: now, value };
  cached = entry;
  value.catch(() => {
    if (cached === entry) cached = null;
  });
  return value;
}

export function resetAgentEnvCacheForTest(): void {
  cached = null;
}

/** One paired PC's summary, read over its web API with its own credential. */
export async function fetchRemoteAgentEnv(host: Pick<RemoteHost, 'origin' | 'token'>, fetchImpl: typeof fetch): Promise<Pick<AgentEnvHost, 'status' | 'summary'>> {
  // Never send the token to another machine over plain http.
  if (!isCredentialSafeOriginString(host.origin)) return { status: 'unavailable', summary: null };
  let res: Response;
  try {
    res = await fetchImpl(`${host.origin}${AGENT_ENV_ROUTE}`, {
      headers: { Authorization: `Bearer ${host.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
  } catch {
    return { status: 'unreachable', summary: null };
  }
  const settle = (status: AgentEnvHost['status']) => {
    void res.body?.cancel().catch(() => undefined);
    return { status, summary: null };
  };
  if (res.status === 401 || res.status === 403) return settle('auth-rejected');
  // A wmux from before the route: its /api answers 404.
  if (res.status === 404) return settle('unsupported');
  if (!res.ok) return settle('unavailable');
  try {
    const summary = parseAgentEnvSummary(await readBoundedJson(res, AGENT_ENV_LIMITS.bodyBytes));
    return summary ? { status: 'ok', summary } : { status: 'unavailable', summary: null };
  } catch {
    return { status: 'unavailable', summary: null };
  }
}

export interface PcEnvDiffDeps {
  local: () => Promise<AgentEnvSummary>;
  /** The paired PCs (id and label), and one with its credential by id. */
  hosts: () => Array<{ id: string; label: string }>;
  host: (id: string) => RemoteHost | null;
  fetchImpl: typeof fetch;
}

export interface PcEnvDiffResult {
  hosts: AgentEnvHost[];
  diff: AgentEnvDiff;
}

/** This PC and every paired PC, read side by side, and where they differ. */
export async function pcEnvDiff(deps: PcEnvDiffDeps): Promise<PcEnvDiffResult> {
  const local: AgentEnvHost = await deps.local()
    .then((summary) => ({ hostId: 'local', name: os.hostname(), status: 'ok' as const, summary }))
    .catch(() => ({ hostId: 'local', name: os.hostname(), status: 'unavailable' as const, summary: null }));
  const remotes = await Promise.all(deps.hosts().map(async ({ id, label }): Promise<AgentEnvHost> => {
    const host = deps.host(id);
    if (!host) return { hostId: id, name: label, status: 'unavailable', summary: null };
    return { hostId: id, name: label, ...(await fetchRemoteAgentEnv(host, deps.fetchImpl)) };
  }));
  const hosts = [local, ...remotes];
  return { hosts, diff: diffAgentEnvs(hosts) };
}
