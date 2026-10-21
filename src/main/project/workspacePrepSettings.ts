/**
 * Main side of the "New workspace setup" section: read what a project's
 * wmux.json declares for new worktrees, list the git-ignored files the user
 * can pick, suggest a setup command from the lockfile, and save.
 *
 * Saving is the user's trust approval: the bytes written are trusted at once
 * (ProjectConfigStore.setDecision with their hash). That is only sound when
 * the user can see everything the file would run. A file holding commands or
 * a layout the user has not approved is therefore never saved over from here
 * ('review-first'): it is reviewed in the trust dialog first, so this section
 * can never approve somebody else's commands unseen.
 *
 * Only `fanout.copy`, `fanout.setup`, `fanout.portRange` and
 * `fanout.copyIntoAutomated` are changed; every other key of the file is kept
 * as it was. Nothing here logs a file's content or a candidate's name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { git as runGit, type GitResult } from '../git/git';
import {
  WMUX_PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_MAX_FILE_BYTES,
  PROJECT_FANOUT_MAX_COPY,
  normFanoutCopyPath,
  normalizeWmuxProjectConfig,
  parseFanoutPortRange,
  type ProjectConfigState,
  type WmuxProjectConfig,
} from '../../shared/wmuxProjectConfig';
import { WORKSPACE_PROFILE_COMMAND_MAX } from '../../shared/types';
import {
  WORKSPACE_PREP_MAX_CANDIDATES,
  isDefaultCopyCandidate,
  type WorkspacePrepSaveResult,
  type WorkspacePrepSettings,
  type WorkspacePrepSettingsView,
} from '../../shared/workspacePrepSettings';

/** Largest file offered as a candidate: config files are small; a big ignored
 *  file is a build output or a database, not a setting. */
const MAX_CANDIDATE_BYTES = 1024 * 1024;

export interface WorkspacePrepSettingsDeps {
  getState: (cwd: string) => Promise<ProjectConfigState>;
  setTrusted: (root: string, contentHash: string, unattended: boolean) => Promise<void>;
  /** The trust record's unattended consent for these bytes (kept across a save). */
  unattendedFor: (root: string, contentHash: string) => Promise<boolean>;
  git?: (args: string[], cwd: string) => Promise<GitResult>;
}

/** Lockfile → install command, first match wins (checked in this order). */
const LOCKFILE_SETUP: ReadonlyArray<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm ci'],
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install'],
  ['Pipfile.lock', 'pipenv sync'],
  ['Gemfile.lock', 'bundle install'],
  ['composer.lock', 'composer install'],
  ['Cargo.lock', 'cargo fetch'],
  ['go.sum', 'go mod download'],
];

export function suggestSetupCommand(root: string): string | undefined {
  for (const [file, command] of LOCKFILE_SETUP) {
    try {
      if (fs.statSync(path.join(root, file)).isFile()) return command;
    } catch {
      // not this one
    }
  }
  return undefined;
}

/**
 * Git-ignored plain files under `root`, project-relative with forward
 * slashes: what a new worktree would not get from git. Ignored directories
 * (node_modules, build output) are collapsed by git and left out. `.env*`
 * come first.
 */
export async function listCopyCandidates(root: string, gitRun: NonNullable<WorkspacePrepSettingsDeps['git']> = runGit): Promise<string[]> {
  const r = await gitRun(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], root);
  if (r.code !== 0) return [];
  const out: string[] = [];
  for (const raw of r.stdout.split('\0')) {
    if (raw.length === 0 || raw.endsWith('/')) continue;
    const rel = normFanoutCopyPath(raw);
    if (rel === undefined || rel === WMUX_PROJECT_CONFIG_FILENAME) continue;
    try {
      const st = fs.lstatSync(path.join(root, ...rel.split('/')));
      if (!st.isFile() || st.size > MAX_CANDIDATE_BYTES) continue;
    } catch {
      continue;
    }
    out.push(rel);
  }
  // Sorted before the cap, so a `.env` deep in a big tree is never cut.
  return out
    .sort((a, b) => Number(isDefaultCopyCandidate(b)) - Number(isDefaultCopyCandidate(a)) || a.localeCompare(b))
    .slice(0, WORKSPACE_PREP_MAX_CANDIDATES);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Where the project's wmux.json is (or would be): the discovered file, else
 *  the checkout's top. */
async function locate(cwd: string, deps: WorkspacePrepSettingsDeps): Promise<{ state: ProjectConfigState; dir: string } | null> {
  const state = await deps.getState(cwd).catch((): ProjectConfigState => ({ found: false }));
  if (state.found && state.configPath) return { state, dir: path.dirname(state.configPath) };
  const top = await (deps.git ?? runGit)(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return null;
  return { state, dir: path.resolve(top.stdout.trim()) };
}

/**
 * True when an unapproved file can run something: commands, a layout, or a
 * setup command somebody else wrote. A one-line field is no place to review
 * a shell command (a long tail or a newline hides in it), so such a file is
 * reviewed in the trust dialog, which shows it verbatim, before this section
 * may save over it.
 */
function hasRunnables(config: WmuxProjectConfig | undefined): boolean {
  if (!config) return false;
  return config.layout !== undefined || (config.commands?.length ?? 0) > 0 || config.fanout?.setup !== undefined;
}

/** The live bytes are the approved ones (not just a cached verdict). */
function trustedNow(state: ProjectConfigState, liveHash: string | undefined): boolean {
  return state.trust === 'trusted' && liveHash !== undefined && state.contentHash === liveHash;
}

function saveBlock(state: ProjectConfigState): WorkspacePrepSettingsView['saveBlocked'] {
  if (!state.found) return undefined;
  if (state.invalid) return 'invalid';
  // 'denied' is sticky: the trust dialog is where it is lifted.
  if (state.trust === 'denied') return 'review-first';
  if (state.trust !== 'trusted' && hasRunnables(state.config)) return 'review-first';
  return undefined;
}

function settingsOf(config: WmuxProjectConfig | undefined): WorkspacePrepSettings {
  const f = config?.fanout;
  return {
    copy: f?.copy ?? [],
    setup: f?.setup ?? '',
    portRange: f?.portRange ? `${f.portRange.min}-${f.portRange.max}` : '',
    copyIntoAutomated: f?.copyIntoAutomated === true,
  };
}

export async function readWorkspacePrepSettings(cwd: string, deps: WorkspacePrepSettingsDeps): Promise<WorkspacePrepSettingsView> {
  const empty: WorkspacePrepSettings = { copy: [], setup: '', portRange: '', copyIntoAutomated: false };
  const found = await locate(cwd, deps);
  if (!found) return { exists: false, settings: empty, copyUnset: true, candidates: [], saveBlocked: 'no-project' };
  const { state, dir } = found;
  const settings = settingsOf(state.config);
  const candidates = await listCopyCandidates(dir, deps.git ?? runGit);
  const suggestedSetup = suggestSetupCommand(dir);
  const blocked = saveBlock(state);
  return {
    root: dir,
    ...(state.found && state.contentHash ? { contentHash: state.contentHash } : {}),
    exists: state.found === true,
    settings,
    copyUnset: state.config?.fanout?.copy === undefined,
    candidates,
    ...(suggestedSetup ? { suggestedSetup } : {}),
    ...(blocked ? { saveBlocked: blocked } : {}),
  };
}

/** Validate what the renderer sent; undefined when anything is off. */
export function parseWorkspacePrepSettings(raw: unknown): WorkspacePrepSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.copy) || typeof r.setup !== 'string' || typeof r.portRange !== 'string' || typeof r.copyIntoAutomated !== 'boolean') return undefined;
  if (r.copy.length > PROJECT_FANOUT_MAX_COPY) return undefined;
  const copy: string[] = [];
  for (const entry of r.copy) {
    const norm = normFanoutCopyPath(entry);
    if (norm === undefined) return undefined;
    if (!copy.includes(norm)) copy.push(norm);
  }
  if (r.setup.length > WORKSPACE_PROFILE_COMMAND_MAX) return undefined;
  const portRange = r.portRange.trim();
  if (portRange.length > 0 && !parseFanoutPortRange(portRange).ok) return undefined;
  return { copy, setup: r.setup.trim().length > 0 ? r.setup : '', portRange, copyIntoAutomated: r.copyIntoAutomated };
}

/**
 * Write the section's settings into wmux.json and trust the written bytes.
 * `expectedHash` is the hash the section showed (absent: it showed no file);
 * a file changed since then is not overwritten ('changed').
 */
export async function saveWorkspacePrepSettings(
  cwd: string,
  input: WorkspacePrepSettings,
  expectedHash: string | undefined,
  deps: WorkspacePrepSettingsDeps,
): Promise<WorkspacePrepSaveResult> {
  const found = await locate(cwd, deps);
  if (!found) return { ok: false, error: 'no-project' };
  const configPath = path.join(found.dir, WMUX_PROJECT_CONFIG_FILENAME);

  let before: Buffer | null = null;
  try {
    const st = fs.lstatSync(configPath);
    if (!st.isFile() || st.size > PROJECT_CONFIG_MAX_FILE_BYTES) return { ok: false, error: 'invalid' };
    before = fs.readFileSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'write-failed' };
  }
  const liveHash = before ? sha256Hex(before) : undefined;
  if (liveHash !== expectedHash) return { ok: false, error: 'changed' };

  let doc: Record<string, unknown> = { version: 1 };
  if (before) {
    try {
      const parsed: unknown = JSON.parse(before.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'invalid' };
      doc = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'invalid' };
    }
    // Re-checked against the bytes about to be replaced, not the view the
    // renderer had: never approve commands the user has not reviewed.
    const state: ProjectConfigState = found.state.found ? found.state : { found: true };
    const config = normalizeWmuxProjectConfig(doc);
    if (state.trust === 'denied') return { ok: false, error: 'review-first' };
    if (!trustedNow(state, liveHash) && hasRunnables(config)) return { ok: false, error: 'review-first' };
  }

  const prevFanout = doc.fanout && typeof doc.fanout === 'object' && !Array.isArray(doc.fanout) ? { ...(doc.fanout as Record<string, unknown>) } : {};
  const fanout: Record<string, unknown> = { ...prevFanout };
  for (const key of ['copy', 'setup', 'portRange', 'copyIntoAutomated']) delete fanout[key];
  if (input.portRange) fanout.portRange = input.portRange;
  if (input.setup) fanout.setup = input.setup;
  if (input.copy.length > 0) fanout.copy = input.copy;
  if (input.copyIntoAutomated) fanout.copyIntoAutomated = true;
  if (Object.keys(fanout).length > 0) doc.fanout = fanout;
  else delete doc.fanout;

  // The result must read back as exactly what was asked for.
  const check = normalizeWmuxProjectConfig(doc);
  if (!check || (check.fanout?.invalidFields?.length ?? 0) > 0) return { ok: false, error: 'invalid-input' };

  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const tmp = path.join(found.dir, `.${WMUX_PROJECT_CONFIG_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return { ok: false, error: 'write-failed', detail: (err as NodeJS.ErrnoException).code ?? 'unknown' };
  }
  const contentHash = sha256Hex(bytes);
  // The trust key is the root the store finds from this cwd (it keeps a
  // symlinked spelling git's top resolves away), read back from the file
  // just written.
  const after = await deps.getState(cwd).catch((): ProjectConfigState => ({ found: false }));
  const root = after.found && after.contentHash === contentHash && after.root ? after.root : found.state.root ?? found.dir;
  // The unattended reboot consent was given for the layout, which this save
  // does not touch: it carries over only from bytes that were trusted.
  const unattended = trustedNow(found.state, liveHash) && liveHash !== undefined ? await deps.unattendedFor(root, liveHash) : false;
  await deps.setTrusted(root, contentHash, unattended);
  return { ok: true, contentHash };
}
