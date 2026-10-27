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
import { constants as fsConstants } from 'node:fs';
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
  /** An instruction file's bytes, 'absent' or 'unreadable'. */
  readInstruction?: (p: string) => Promise<Buffer | 'absent' | 'unreadable'>;
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
  const nearest: string[] = [];
  try {
    let dir = path.dirname(await deps.realpath(executable));
    for (let i = 0; i < 6; i++) {
      nearest.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable: the shim layouts only */
  }
  // Nearest to the real binary first, then the shim layouts.
  for (const dir of [...nearest, ...candidates]) {
    const version = await read(dir);
    if (version) return version;
  }
  return null;
}

/**
 * An instruction file's bytes, read through ONE handle: opened non-blocking
 * (a link to a FIFO cannot hang the open), checked to be a regular file under
 * the cap, then read from that same handle, so nothing can swap it between
 * the check and the read.
 */
async function readInstructionFile(p: string): Promise<Buffer | 'absent' | 'unreadable'> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > INSTRUCTION_MAX_BYTES) return 'unreadable';
    const bytes = await fh.readFile();
    return bytes.length > INSTRUCTION_MAX_BYTES ? 'unreadable' : bytes;
  } catch {
    return 'unreadable';
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Inventory warnings that mean part of the configuration was not read (helpers.ts safeRead*). */
function readFailed(inv: ProviderInventory): boolean {
  return inv.warnings.some((w) => w.startsWith('Failed to read ') || w.startsWith('Failed to parse '));
}

export async function collectAgentEnvSummary(deps: AgentEnvDeps): Promise<AgentEnvSummary> {
  const home = deps.homeDir ?? os.homedir();
  const readInv = deps.readInventory ?? ((provider: SurfaceProviderId) => readInventory(provider));
  const io = {
    readFile: deps.readFile ?? ((p: string) => fs.readFile(p)),
    realpath: deps.realpath ?? ((p: string) => fs.realpath(p)),
  };
  const readInstruction = deps.readInstruction ?? readInstructionFile;
  // The PATH the inventory's own probes run with (Homebrew and npm prefixes
  // included), not a Finder-launched app's bare one.
  const resolve = deps.resolveCommand ?? ((command: string) => resolveOnPath(command, getExecEnv()));
  const read = await Promise.all(INVENTORY_PROVIDERS.map((p) => readInv(p).then((inv) => ({ p, inv }), () => ({ p, inv: null }))));
  const inventories = read.map((r) => r.inv).filter((inv): inv is ProviderInventory => inv !== null);
  // A provider that could not be read, in whole or in part, is reported as
  // such, never as having nothing.
  const unread = read.filter((r) => r.inv === null || readFailed(r.inv)).map((r) => r.p);
  const versions: AgentEnvAgent[] = await Promise.all(PACKAGE_AGENTS.map(async ({ agent, command, pkg }) => {
    const executable = resolve(command);
    if (!executable) return { agent, version: null };
    // Installed, but in a layout whose package is not found: say so, not "absent".
    return { agent, version: (await packageVersion(executable, pkg, io)) ?? 'unknown' };
  }));
  const instructions: AgentEnvInstruction[] = await Promise.all(INSTRUCTION_FILES.map(async (rel): Promise<AgentEnvInstruction> => {
    const file = `~/${rel}`;
    const got = await readInstruction(path.join(home, ...rel.split('/')));
    if (got === 'absent') return { file, sha256: null };
    if (got === 'unreadable') return { file, sha256: null, unreadable: true };
    return { file, sha256: createHash('sha256').update(got).digest('hex') };
  }));
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
