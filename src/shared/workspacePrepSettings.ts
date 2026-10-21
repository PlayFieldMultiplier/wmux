/**
 * The project settings the "New workspace setup" section edits: which
 * git-ignored config files a new worktree gets, the setup command, and the
 * per-task port range. Stored in the project's `wmux.json` under `fanout`
 * (see wmuxProjectConfig.ts); saving them there is the user's trust approval
 * of the saved bytes.
 */

export interface WorkspacePrepSettings {
  /** Project-relative files to copy (`fanout.copy`). */
  copy: string[];
  /** Setup command (`fanout.setup`); '' = none. */
  setup: string;
  /** `"min-max"` (`fanout.portRange`); '' = none. */
  portRange: string;
  /** `fanout.copyIntoAutomated`. */
  copyIntoAutomated: boolean;
}

/** Why the section cannot save over the current file. */
export type WorkspacePrepSaveBlock =
  /** The file holds commands or a layout the user has not approved: saving
   *  would approve them unseen, so they are reviewed in the trust dialog first. */
  | 'review-first'
  /** The file is not valid JSON or not a usable wmux.json. */
  | 'invalid'
  /** No folder to save into (not a git checkout). */
  | 'no-project';

export interface WorkspacePrepSettingsView {
  /** Folder whose wmux.json is read and written. */
  root?: string;
  /** Hash of the file's bytes as read (absent: no file yet). Sent back on save. */
  contentHash?: string;
  /** True when a wmux.json exists. */
  exists: boolean;
  /** What the file declares now (empty when there is none). */
  settings: WorkspacePrepSettings;
  /** True when the user has not configured copying yet (drives the default
   *  ticks: only the `.env*` family). */
  copyUnset: boolean;
  /** Git-ignored files in the checkout the user can pick from (capped). */
  candidates: string[];
  /** A setup command derived from the lockfile, when one is recognised. */
  suggestedSetup?: string;
  /** Present when saving is refused, and why. */
  saveBlocked?: WorkspacePrepSaveBlock;
}

export type WorkspacePrepSaveResult =
  | { ok: true; contentHash: string }
  | { ok: false; error: 'changed' | 'invalid-input' | WorkspacePrepSaveBlock | 'write-failed'; detail?: string };

/** The `.env` family ticked by default: `.env`, `.env.local`, `.env.development`, … */
export function isDefaultCopyCandidate(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (!/^\.env(\..+)?$/.test(base)) return false;
  // Templates are checked in, not secrets; they are not what a worktree misses.
  return !/\.(example|sample|template|dist|defaults?)$/.test(base);
}

/** Most candidates listed. */
export const WORKSPACE_PREP_MAX_CANDIDATES = 200;
