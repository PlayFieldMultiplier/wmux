// ─── Workspace repositories — `<wmuxDir>/factory/workspace-repos.json` ─────
//
// A workspace works on one repository (botCreate.ts). This file remembers
// the owner's answer for each workspace, so Add bot, Add team and the first
// run ask once:
//   - `repo`: the repository its bots work on, written whenever a bot of the
//     workspace gets one from a folder (Add bot, Add team, the first run, a
//     profile's Change, a pipe `bot.update` that sets a repo);
//   - `none`: the owner chose no repository there (None, or Add after the
//     workspace's folder was refused), so the suggestion stops reading the
//     workspace's folder until a folder is picked.
// botCreate.ts workspaceRepo reads `repo` before the bots themselves.
//
// The file is main-owned and versioned like the factory's other stores
// (versionedFile.ts). One that cannot be read is never overwritten: the
// store then remembers nothing and writes nothing, and the bots' own repos
// still answer.

import path from 'node:path';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const WORKSPACE_REPOS_FILENAME = 'workspace-repos.json';
export const WORKSPACE_REPOS_VERSION = 1 as const;

export function workspaceReposPath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', WORKSPACE_REPOS_FILENAME);
}

export interface WorkspaceRepo {
  repoKey: string;
  repoPath: string;
  originPin?: string;
}

/** One workspace's remembered answer; `at` is when it was given (ISO). */
export type WorkspaceRepoRecord =
  | { repo: WorkspaceRepo; at: string }
  | { none: true; at: string };

function validWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200;
}

function sanitizeRepo(raw: unknown): WorkspaceRepo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.repoKey !== 'string' || r.repoKey.length === 0 || typeof r.repoPath !== 'string' || r.repoPath.length === 0) return null;
  return { repoKey: r.repoKey, repoPath: r.repoPath, ...(typeof r.originPin === 'string' && r.originPin ? { originPin: r.originPin } : {}) };
}

function sanitizeRecord(raw: unknown): WorkspaceRepoRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  if (r.none === true) return { none: true, at: r.at };
  const repo = sanitizeRepo(r.repo);
  return repo ? { repo, at: r.at } : null;
}

export interface WorkspaceRepoStoreOptions {
  file: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class WorkspaceRepoStore {
  private records = new Map<string, WorkspaceRepoRecord>();
  private state: 'unloaded' | 'loaded' | 'unreadable' = 'unloaded';
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: WorkspaceRepoStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[factory] ${m}`));
    this.persister = createFilePersister(opts.file, () => ({ version: WORKSPACE_REPOS_VERSION, workspaces: Object.fromEntries(this.records) }));
  }

  /** Read the file (missing → nothing remembered). A file that cannot be
   *  read or carries another version leaves the store unreadable: nothing is
   *  remembered and nothing is written. A malformed entry is dropped. Never
   *  throws. */
  load(): void {
    this.records = new Map();
    try {
      const raw = readVersionedFile(this.opts.file, WORKSPACE_REPOS_VERSION);
      const ws = raw?.workspaces;
      if (ws && typeof ws === 'object' && !Array.isArray(ws)) {
        for (const [id, v] of Object.entries(ws as Record<string, unknown>)) {
          const record = validWorkspaceId(id) ? sanitizeRecord(v) : null;
          if (record) this.records.set(id, record);
          else this.log(`${this.opts.file}: dropped a malformed entry for ${JSON.stringify(id)}`);
        }
      }
      this.state = 'loaded';
    } catch (err) {
      this.records = new Map();
      this.state = 'unreadable';
      this.log(`${this.opts.file} is unreadable; no workspace's repository is remembered until it is fixed: ${String(err)}`);
    }
  }

  /** The workspace's remembered answer, or null. */
  get(workspaceId: unknown): WorkspaceRepoRecord | null {
    if (!validWorkspaceId(workspaceId)) return null;
    const r = this.records.get(workspaceId);
    if (!r) return null;
    return 'repo' in r ? { repo: { ...r.repo }, at: r.at } : { ...r };
  }

  /** Remember the workspace's repository (replacing a None). */
  setRepo(workspaceId: unknown, repo: WorkspaceRepo): void {
    const clean = sanitizeRepo(repo);
    if (!clean) return;
    const current = this.get(workspaceId);
    if (current && 'repo' in current && current.repo.repoKey === clean.repoKey && current.repo.repoPath === clean.repoPath && current.repo.originPin === clean.originPin) return;
    this.write(workspaceId, { repo: clean, at: new Date(this.now()).toISOString() });
  }

  /** Remember that the workspace works on no repository. A remembered
   *  repository is kept: main gives every bot of the workspace its repo. */
  setNone(workspaceId: unknown): void {
    if (this.get(workspaceId)) return;
    this.write(workspaceId, { none: true, at: new Date(this.now()).toISOString() });
  }

  private write(workspaceId: unknown, record: WorkspaceRepoRecord): void {
    if (this.state !== 'loaded' || !validWorkspaceId(workspaceId)) return;
    this.records.set(workspaceId, record);
    void this.persister.schedule().catch((err) => this.log(`${this.opts.file} write failed: ${String(err)}`));
  }

  /** Resolves once every write so far has finished. */
  flush(): Promise<void> {
    return this.persister.settled();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let current: WorkspaceRepoStore | null = null;

/** Set by the bot runtime module's start(). */
export function setWorkspaceRepoStore(store: WorkspaceRepoStore | null): void {
  current = store;
}

export function getWorkspaceRepoStore(): WorkspaceRepoStore | null {
  return current;
}
