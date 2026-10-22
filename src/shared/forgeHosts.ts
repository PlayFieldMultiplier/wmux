// ─── Forge hosts — which hosts the gh and glab CLIs are set up for ─────────
//
// A remote's host names its forge only by convention (github.com, *.ghe.com,
// a `github` label); GitHub Enterprise on its own domain (`code.acme.example`)
// matches none of them. The CLIs themselves know better: gh lists every host
// it is signed in to as a top-level key of its hosts.yml, and glab lists every
// host it is set up for under `hosts:` in its config.yml. A host in one list
// and not the other is that forge's; anything else is left to the caller's
// name rule (main/github/PrProvider.ts isGithubHost).
//
// glab's entry also says how to reach the host: a key with a port
// (`host:8443`, as `glab auth login --hostname host:8443` writes it) and a
// `subfolder` for GitLab served under a sub-path (`https://host/gitlab/`).
//
// Only host names and `subfolder` are kept; the files also hold tokens, so
// nothing read here is ever logged or echoed. Reads are synchronous and
// cached (a stat at most every CHECK_MS, a parse only when the file
// changed), so callers on hot paths stay cheap. Any read or parse failure is
// "no signal", never an error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

export interface GlabHostEntry {
  /** The host as glab's config names it, lowercased (`host` or `host:port`). */
  name: string;
  /** The sub-path GitLab is served under, slashes trimmed; '' at the root. */
  subfolder: string;
}

export interface ForgeHosts {
  /** Hosts gh is signed in to, lowercased. */
  gh: ReadonlySet<string>;
  /** Hosts glab is set up for, by lowercased config key. */
  glab: ReadonlyMap<string, GlabHostEntry>;
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/;
/** How long a stat result is trusted before the file is looked at again. */
const CHECK_MS = 10_000;

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** gh's hosts.yml → its hosts (the top-level keys). Pure. */
export function parseGhHosts(text: string): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(rec(parseYaml(text)) ?? {})) {
    const host = key.trim().toLowerCase();
    if (HOST_RE.test(host)) out.add(host);
  }
  return out;
}

/** glab's config.yml → its hosts (the keys under `hosts:`). Pure. */
export function parseGlabHosts(text: string): Map<string, GlabHostEntry> {
  const out = new Map<string, GlabHostEntry>();
  const hosts = rec(rec(parseYaml(text))?.hosts);
  for (const [key, value] of Object.entries(hosts ?? {})) {
    const name = key.trim().toLowerCase();
    if (!HOST_RE.test(name)) continue;
    const raw = rec(value)?.subfolder;
    const subfolder = typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : '';
    out.set(name, { name, subfolder: /^[\w.-]+(?:\/[\w.-]+)*$/.test(subfolder) ? subfolder : '' });
  }
  return out;
}

/** gh's hosts.yml path, as gh finds its config dir. */
function ghHostsPath(): string {
  const env = process.env;
  if (env.GH_CONFIG_DIR) return path.join(env.GH_CONFIG_DIR, 'hosts.yml');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh', 'hosts.yml');
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'GitHub CLI', 'hosts.yml');
  return path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
}

/** glab's config.yml: the one file glab itself reads (glab 1.108, probed):
 *  GLAB_CONFIG_DIR when set; else the legacy ~/.config/glab-cli when its
 *  config.yml exists; else XDG_CONFIG_HOME/glab-cli when that is set (used
 *  even before the file exists); else the platform's user config dir
 *  (~/Library/Application Support on macOS, %APPDATA% on Windows). */
export function glabConfigPath(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string {
  if (env.GLAB_CONFIG_DIR) return path.join(env.GLAB_CONFIG_DIR, 'config.yml');
  const legacy = path.join(os.homedir(), '.config', 'glab-cli', 'config.yml');
  if (exists(legacy)) return legacy;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'glab-cli', 'config.yml');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml');
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'glab-cli', 'config.yml');
  return legacy;
}

interface FileEntry<T> { checkedAt: number; stamp: string; value: T }
const files = new Map<string, FileEntry<unknown>>();
let glabPath: { at: number; file: string } | null = null;

/** The parsed file at `file`, re-parsed only when its mtime or size moved;
 *  `empty` when it is missing or unreadable. */
function cachedRead<T>(file: string, now: number, parseText: (text: string) => T, empty: T): T {
  const hit = files.get(file) as FileEntry<T> | undefined;
  if (hit && now - hit.checkedAt < CHECK_MS) return hit.value;
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    stamp = '';
  }
  if (hit && hit.stamp === stamp) {
    hit.checkedAt = now;
    return hit.value;
  }
  let value = empty;
  if (stamp) {
    try {
      value = parseText(fs.readFileSync(file, 'utf8'));
    } catch {
      value = empty;
    }
  }
  files.set(file, { checkedAt: now, stamp, value });
  return value;
}

/** The hosts gh and glab are set up for now (cached; see the header). */
export function forgeHosts(now: number = Date.now()): ForgeHosts {
  const gh = cachedRead(ghHostsPath(), now, parseGhHosts, new Set<string>());
  // Which file glab reads is re-decided at the same pace as a file is re-checked.
  if (!glabPath || now - glabPath.at >= CHECK_MS) glabPath = { at: now, file: glabConfigPath() };
  const glab = cachedRead(glabPath.file, now, parseGlabHosts, new Map<string, GlabHostEntry>());
  return { gh, glab };
}

/** Test seam. */
export function clearForgeHostsCache(): void {
  files.clear();
  glabPath = null;
}

/** glab's entry for a remote's (port-less) host: the entry named exactly so,
 *  else the one `host:port` entry for it. Null when there is none, or more
 *  than one port to choose from. Pure. */
export function glabEntryFor(host: string, hosts: ForgeHosts): GlabHostEntry | null {
  const h = host.toLowerCase();
  const exact = hosts.glab.get(h);
  if (exact) return exact;
  const ported = [...hosts.glab.values()].filter((e) => e.name.startsWith(`${h}:`));
  return ported.length === 1 ? ported[0] : null;
}

/** An http(s) remote's path segments without the `subfolder` of glab's
 *  entry for its host: GitLab served under a sub-path has the https remote
 *  `https://host/sub/group/proj` for the project `group/proj`, and its ssh
 *  remote (`git@host:group/proj`) never carries `sub` — so only an http(s)
 *  remote's path is passed here. Kept whole when what would follow is not at
 *  least group/project. Pure. */
export function dropGlabSubfolder(host: string, parts: readonly string[], hosts: ForgeHosts): string[] {
  const sub = glabEntryFor(host, hosts)?.subfolder.toLowerCase().split('/').filter(Boolean) ?? [];
  const matches = sub.length > 0 && parts.length - sub.length >= 2 && sub.every((s, i) => parts[i]?.toLowerCase() === s);
  return matches ? parts.slice(sub.length) : [...parts];
}

/** The forge a host's CLI config names: gh signed in to it and glab not set
 *  up for it → github; the other way round → gitlab; neither or both → null
 *  (the caller's name rule decides). Pure. */
export function configuredForge(host: string, hosts: ForgeHosts): 'github' | 'gitlab' | null {
  const h = host.toLowerCase();
  const gh = hosts.gh.has(h);
  const glab = glabEntryFor(h, hosts) !== null;
  return gh === glab ? null : gh ? 'github' : 'gitlab';
}
