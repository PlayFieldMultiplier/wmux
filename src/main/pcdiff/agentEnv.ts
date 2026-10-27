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
import { getExecEnv } from '../../shared/execEnv';
import type { ProviderInventory, SurfaceProviderId } from '../../shared/tokenUsage/surfaceTypes';
import { AGENT_ENV_LIMITS, AGENT_ENV_ROUTE, buildAgentEnvSummary, parseAgentEnvSummary, type AgentEnvAgent, type AgentEnvInstruction, type AgentEnvSummary } from '../../shared/agentEnvSummary';
import { diffAgentEnvs, type AgentEnvDiff, type AgentEnvHost } from '../../shared/agentEnvDiff';
import { resolveOnPath } from '../factory/botEngines';
import { getJson } from '../remote/pcRailFeed';
import { readInventory } from '../surfaces/inventory';

export const AGENT_ENV_CACHE_MS = 60_000;
/** An instruction file larger than this is not read (they are a few KB). */
const INSTRUCTION_MAX_BYTES = 4 * 1024 * 1024;
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
  stat?: (p: string) => Promise<{ isFile(): boolean; size: number }>;
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

/** SHA-256 of a file's bytes exactly as stored; null when there is no such
 *  regular file, it is too large, or it cannot be read. Checked before the
 *  read, so a link to a FIFO or a device never blocks it. */
async function hashFile(p: string, io: { readFile: (p: string) => Promise<Buffer>; stat: (p: string) => Promise<{ isFile(): boolean; size: number }> }): Promise<string | null> {
  try {
    const st = await io.stat(p);
    if (!st.isFile() || st.size > INSTRUCTION_MAX_BYTES) return null;
    return createHash('sha256').update(await io.readFile(p)).digest('hex');
  } catch {
    return null;
  }
}

export async function collectAgentEnvSummary(deps: AgentEnvDeps): Promise<AgentEnvSummary> {
  const home = deps.homeDir ?? os.homedir();
  const readInv = deps.readInventory ?? ((provider: SurfaceProviderId) => readInventory(provider));
  const io = {
    readFile: deps.readFile ?? ((p: string) => fs.readFile(p)),
    realpath: deps.realpath ?? ((p: string) => fs.realpath(p)),
    stat: deps.stat ?? ((p: string) => fs.stat(p)),
  };
  // The PATH the inventory's own probes run with (Homebrew and npm prefixes
  // included), not a Finder-launched app's bare one.
  const resolve = deps.resolveCommand ?? ((command: string) => resolveOnPath(command, getExecEnv()));
  const read = await Promise.all(INVENTORY_PROVIDERS.map((p) => readInv(p).then((inv) => ({ p, inv }), () => ({ p, inv: null }))));
  const inventories = read.map((r) => r.inv).filter((inv): inv is ProviderInventory => inv !== null);
  // A provider that could not be read is reported as such, never as having nothing.
  const unread = read.filter((r) => r.inv === null).map((r) => r.p);
  const versions: AgentEnvAgent[] = await Promise.all(PACKAGE_AGENTS.map(async ({ agent, command, pkg }) => {
    const executable = resolve(command);
    return { agent, version: executable ? await packageVersion(executable, pkg, io) : null };
  }));
  const instructions: AgentEnvInstruction[] = await Promise.all(INSTRUCTION_FILES.map(async (rel) => ({
    file: `~/${rel}`,
    sha256: await hashFile(path.join(home, ...rel.split('/')), io),
  })));
  return buildAgentEnvSummary({ wmuxVersion: deps.wmuxVersion, inventories, unread, versions, instructions });
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

/** One paired PC's summary, read over its web API with its own credential
 *  (the PC rail's request: the same origin, redirect and timeout rules). */
export async function fetchRemoteAgentEnv(host: Pick<RemoteHost, 'origin' | 'token'>, fetchImpl: typeof fetch): Promise<Pick<AgentEnvHost, 'status' | 'summary'>> {
  const got = await getJson(host, AGENT_ENV_ROUTE, AGENT_ENV_LIMITS.bodyBytes, fetchImpl);
  if (!got.ok) {
    // A wmux from before the route: its /api answers 404.
    if (got.reason === 'unavailable' && got.status === 404) return { status: 'unsupported', summary: null };
    return { status: got.reason, summary: null };
  }
  const summary = parseAgentEnvSummary(got.body);
  return summary ? { status: 'ok', summary } : { status: 'unavailable', summary: null };
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
