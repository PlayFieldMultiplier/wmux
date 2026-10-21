/**
 * New workspace preparation: what runs in a freshly created worktree before
 * its agent starts, on every path that creates one (the Git page, a phone
 * request, fan-out tasks and bot workers).
 *
 * Two steps, both declared in the repo's `wmux.json` and both behind the SAME
 * trust gate as `fanout.setup` (fanoutEnvironment.resolveFanoutSetup):
 *   1. copy the git-ignored config files the user selected (`fanout.copy`,
 *      e.g. `.env`) from the source checkout into the worktree;
 *   2. run the setup command (`fanout.setup`, e.g. `npm ci`).
 *
 * Copied files are secrets an agent in that worktree can read. They are copied
 * into worktrees a person opened; into bot and fan-out worktrees only when
 * `fanout.copyIntoAutomated` is on. Nothing here logs a file's content or a
 * path: results carry counts only.
 *
 * Every copied file must stay git-ignored in the worktree (checked after the
 * copy; a file that is not ignored there is removed again), so it can never be
 * committed by accident and `git worktree remove` deletes it with the folder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import type { PhoneWorktreePrep } from '../../shared/phoneGitV1';
import { git as runGit, type GitResult } from '../git/git';
import {
  FANOUT_SETUP_TIMEOUT_MS,
  resolveFanoutSetup,
  runFanoutSetup,
  type FanoutSetupRunResult,
  type FanoutSetupSkipReason,
} from './fanoutEnvironment';

/** Who opened the worktree. 'automated' = a fan-out task or a bot worker. */
export type WorkspacePrepOrigin = 'human' | 'automated';

/** Lines of setup output kept for a failure report. */
export const WORKSPACE_PREP_TAIL_LINES = 12;

export type WorkspacePrepSkipReason = Exclude<FanoutSetupSkipReason, 'none-declared'>;

export interface WorkspacePrepPlan {
  /** Files to copy (empty when none are declared or copying is not allowed). */
  copy: string[];
  /** Copy is declared but not allowed for this origin (automated, toggle off). */
  copyBlocked?: true;
  /** Setup command to run (absent = none declared). */
  setup?: string;
  /**
   * Set when nothing runs because the config is not approved, or because a
   * declared part was rejected by the schema. Never silent: the caller shows it.
   */
  skipped?: WorkspacePrepSkipReason;
}

/**
 * Decide what the preparation does for this project and origin. Pure.
 *
 * Trust gates the WHOLE preparation, copying included: a `fanout.copy` list
 * that arrived in somebody else's PR must not move a secret into a worktree
 * until the user has approved those exact bytes.
 */
export function resolveWorkspacePrep(
  state: ProjectConfigState | null | undefined,
  origin: WorkspacePrepOrigin,
): WorkspacePrepPlan {
  const fanout = state?.config?.fanout;
  const copyInvalid = fanout?.invalidFields?.includes('copy') === true || fanout?.invalidFields?.includes('copyIntoAutomated') === true;
  const declaredCopy = fanout?.copy ?? [];
  const setup = resolveFanoutSetup(state);
  const anyDeclared = declaredCopy.length > 0 || copyInvalid || setup.run || setup.reason !== 'none-declared';
  if (!state?.found || !anyDeclared) return { copy: [] };
  if (state.trust === 'denied') return { copy: [], skipped: 'denied' };
  if (state.trust === 'stale') return { copy: [], skipped: 'stale' };
  if (state.trust !== 'trusted') return { copy: [], skipped: 'untrusted' };
  // A rejected part means the author asked for something that is not going to
  // happen; running only the rest would hand over a half-prepared worktree.
  if (copyInvalid || (!setup.run && setup.reason === 'malformed')) return { copy: [], skipped: 'malformed' };

  const plan: WorkspacePrepPlan = { copy: [] };
  if (declaredCopy.length > 0) {
    if (origin === 'automated' && fanout?.copyIntoAutomated !== true) plan.copyBlocked = true;
    else plan.copy = [...declaredCopy];
  }
  if (setup.run) plan.setup = setup.command;
  return plan;
}

/** True when the plan does anything at all (or reports a skip). */
export function workspacePrepHasWork(plan: WorkspacePrepPlan): boolean {
  return plan.copy.length > 0 || plan.setup !== undefined || plan.skipped !== undefined || plan.copyBlocked === true;
}

export interface WorkspaceCopyResult {
  copied: number;
  /** Selected but not in the source checkout. */
  missing: number;
  /** Already in the new worktree (never overwritten). */
  present: number;
  /** Not copied: not a plain file, outside the checkout, or not git-ignored. */
  refused: number;
}

export type WorkspacePrepPhase = 'copying' | 'setup';

export interface WorkspacePrepProgress {
  phase: WorkspacePrepPhase;
  copy: WorkspaceCopyResult;
  /** ms epoch the setup command started (phase 'setup'). */
  setupStartedAt?: number;
  /** The setup budget, so a progress line can show "1:20 of 5:00". */
  setupTimeoutMs?: number;
}

export type WorkspacePrepStatus = 'none' | 'skipped' | 'ready' | 'failed';

export interface WorkspacePrepResult {
  status: WorkspacePrepStatus;
  /** status 'skipped': why nothing ran. */
  reason?: WorkspacePrepSkipReason;
  copy: WorkspaceCopyResult;
  copyBlocked?: true;
  setupRan: boolean;
  /** status 'failed': the setup command's failure (exit code, signal, timeout). */
  error?: string;
  timedOut?: true;
  /** status 'failed': the last lines the setup command printed. */
  outputTail?: string[];
}

export interface WorkspacePrepDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  runSetup?: (command: string, cwd: string, env: Record<string, string>, timeoutMs: number) => Promise<FanoutSetupRunResult>;
  now?: () => number;
}

const EMPTY_COPY: WorkspaceCopyResult = { copied: 0, missing: 0, present: 0, refused: 0 };

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function isIgnored(gitRun: NonNullable<WorkspacePrepDeps['git']>, cwd: string, rel: string): Promise<boolean> {
  // check-ignore exits 0 when the path is ignored, 1 when it is not, 128 on
  // error; only 0 is a yes. A tracked file reads as not ignored.
  const r = await gitRun(['check-ignore', '-q', '--', rel], cwd);
  return r.code === 0;
}

/**
 * Copy `entries` (validated project-relative paths) from `sourceRoot` into
 * `worktreePath`. A file is copied only when it is (or links to) a plain file
 * inside the source checkout, git-ignored there, not already in the worktree, lands
 * inside the worktree (no tracked symlink can redirect the write), and is
 * still git-ignored in the worktree afterwards.
 */
export async function copyWorkspaceFiles(
  sourceRoot: string,
  worktreePath: string,
  entries: readonly string[],
  deps: WorkspacePrepDeps = {},
): Promise<WorkspaceCopyResult> {
  const gitRun = deps.git ?? runGit;
  const result: WorkspaceCopyResult = { ...EMPTY_COPY };
  let realSource: string;
  let realWorktree: string;
  try {
    realSource = fs.realpathSync.native(sourceRoot);
    realWorktree = fs.realpathSync.native(worktreePath);
  } catch {
    result.refused = entries.length;
    return result;
  }

  for (const entry of entries) {
    const parts = entry.split('/');
    const src = path.join(realSource, ...parts);
    let realSrc: string;
    try {
      // A link (`.env -> .env.local`) is followed, but only to a file inside
      // the source checkout.
      realSrc = fs.realpathSync.native(src);
    } catch {
      result.missing++;
      continue;
    }
    try {
      if (!within(realSource, realSrc) || !(await isIgnored(gitRun, realSource, entry))) {
        result.refused++;
        continue;
      }
      const dest = path.join(realWorktree, ...parts);
      if (fs.existsSync(dest) || isDanglingLink(dest)) {
        result.present++;
        continue;
      }
      // Checked before anything is created: a tracked link among the parent
      // folders must not make a folder outside the worktree.
      if (!parentStaysInside(realWorktree, path.dirname(dest))) {
        result.refused++;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!within(realWorktree, fs.realpathSync.native(path.dirname(dest))) || !copyPlainFile(realSrc, dest)) {
        result.refused++;
        continue;
      }
      if (!(await isIgnored(gitRun, realWorktree, entry))) {
        // The worktree's own ignore rules differ from the source's: a copy
        // that git would offer to commit must not stay.
        fs.rmSync(dest, { force: true });
        result.refused++;
        continue;
      }
      result.copied++;
    } catch {
      result.refused++;
    }
  }
  return result;
}

/**
 * The project's folder inside a new worktree. `wmux.json` may sit below the
 * repository's top (a package in a monorepo), and its `fanout.copy` paths are
 * relative to that folder in both checkouts. Undefined when the project root
 * is not inside `sourceTop`.
 */
export function worktreeProjectDir(sourceTop: string, projectRoot: string, worktreePath: string): string | undefined {
  let top: string;
  let root: string;
  try {
    top = fs.realpathSync.native(sourceTop);
    root = fs.realpathSync.native(projectRoot);
  } catch {
    return undefined;
  }
  if (!within(top, root)) return undefined;
  const rel = path.relative(top, root);
  return rel === '' ? worktreePath : path.join(worktreePath, rel);
}

/** Largest config file copied (a bigger one is not a setting). */
const MAX_COPY_BYTES = 8 * 1024 * 1024;

/** The nearest existing folder at or above `dir` resolves inside `root`. */
function parentStaysInside(root: string, dir: string): boolean {
  let current = dir;
  for (;;) {
    try {
      return within(root, fs.realpathSync.native(current));
    } catch {
      const up = path.dirname(current);
      if (up === current) return false;
      current = up;
    }
  }
}

/**
 * Copy one resolved plain file. The source is opened without following a
 * link (it was resolved already, so a link appearing there now is a swap)
 * and checked to be a regular file on the open descriptor; the destination
 * is created exclusively, with the source's permission bits.
 */
function copyPlainFile(realSrc: string, dest: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(realSrc, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_COPY_BYTES) return false;
    const bytes = fs.readFileSync(fd);
    try {
      fs.writeFileSync(dest, bytes, { flag: 'wx', mode: st.mode & 0o777 });
    } catch (err) {
      // A write cut short (a full disk) must not leave half a secret behind;
      // a destination that already existed ('wx' refused it) is not ours.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') fs.rmSync(dest, { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isDanglingLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function tailLines(tail: string | undefined): string[] | undefined {
  const text = (tail ?? '').trim();
  if (text.length === 0) return undefined;
  return text.split(/\r?\n/).slice(-WORKSPACE_PREP_TAIL_LINES);
}

export interface RunWorkspacePrepInput {
  plan: WorkspacePrepPlan;
  /** The project folder (holding wmux.json) in the source checkout. */
  sourceRoot: string;
  /** The same folder inside the new worktree (worktreeProjectDir); absent when
   *  it could not be mapped, which refuses every copy. */
  copyDestDir?: string;
  /** Where the setup command runs: the new worktree's top. */
  worktreePath: string;
  /** Env for the setup command (e.g. WMUX_TASK_PORT). */
  env?: Record<string, string>;
  onProgress?: (progress: WorkspacePrepProgress) => void;
  timeoutMs?: number;
}

/**
 * Run a resolved plan: copy, then setup. Never throws. A failed setup is a
 * 'failed' result; the caller must not start the agent on it.
 */
export async function runWorkspacePrep(input: RunWorkspacePrepInput, deps: WorkspacePrepDeps = {}): Promise<WorkspacePrepResult> {
  const { plan } = input;
  const base = { copy: { ...EMPTY_COPY }, setupRan: false, ...(plan.copyBlocked ? { copyBlocked: true as const } : {}) };
  if (plan.skipped) return { ...base, status: 'skipped', reason: plan.skipped };
  if (plan.copy.length === 0 && plan.setup === undefined) return { ...base, status: 'none' };

  const now = deps.now ?? Date.now;
  const report = (progress: WorkspacePrepProgress): void => {
    try { input.onProgress?.(progress); } catch { /* a progress sink never fails the preparation */ }
  };

  let copy: WorkspaceCopyResult = { ...EMPTY_COPY };
  if (plan.copy.length > 0) {
    report({ phase: 'copying', copy });
    copy = input.copyDestDir
      ? await copyWorkspaceFiles(input.sourceRoot, input.copyDestDir, plan.copy, deps)
      : { ...EMPTY_COPY, refused: plan.copy.length };
  }
  if (plan.setup === undefined) return { ...base, status: 'ready', copy };

  const timeoutMs = input.timeoutMs ?? FANOUT_SETUP_TIMEOUT_MS;
  report({ phase: 'setup', copy, setupStartedAt: now(), setupTimeoutMs: timeoutMs });
  const run = deps.runSetup ?? runFanoutSetup;
  const outcome = await run(plan.setup, input.worktreePath, input.env ?? {}, timeoutMs);
  if (outcome.ok) return { ...base, status: 'ready', copy, setupRan: true };
  const outputTail = tailLines(outcome.tail);
  return {
    ...base,
    status: 'failed',
    copy,
    setupRan: true,
    error: outcome.summary ?? outcome.error,
    ...(outcome.timedOut ? { timedOut: true as const } : {}),
    ...(outputTail ? { outputTail } : {}),
  };
}

export interface PrepareNewWorktreeInput {
  /** Any folder of the source checkout (a workspace's cwd, a session's cwd). */
  sourceCwd: string;
  worktreePath: string;
  origin: WorkspacePrepOrigin;
  env?: Record<string, string>;
  onProgress?: (progress: WorkspacePrepProgress) => void;
  timeoutMs?: number;
}

export interface PrepareNewWorktreeDeps extends WorkspacePrepDeps {
  /** The trust-gated wmux.json reader (ProjectConfigStore.getState). */
  getState: (cwd: string) => Promise<ProjectConfigState>;
}

/**
 * Discover, gate and run the preparation for one new worktree. Used by every
 * path that is not a fan-out (fan-out resolves the plan once for N tasks).
 */
export async function prepareNewWorktree(input: PrepareNewWorktreeInput, deps: PrepareNewWorktreeDeps): Promise<WorkspacePrepResult> {
  let state: ProjectConfigState;
  try {
    state = await deps.getState(input.sourceCwd);
  } catch {
    state = { found: false };
  }
  const plan = resolveWorkspacePrep(state, input.origin);
  let copyDestDir: string | undefined;
  if (plan.copy.length > 0 && state.root) {
    const top = await (deps.git ?? runGit)(['rev-parse', '--show-toplevel'], input.sourceCwd);
    if (top.code === 0) copyDestDir = worktreeProjectDir(top.stdout.trim(), state.root, input.worktreePath);
  }
  return runWorkspacePrep(
    {
      plan,
      sourceRoot: state.root ?? input.sourceCwd,
      ...(copyDestDir ? { copyDestDir } : {}),
      worktreePath: input.worktreePath,
      ...(input.env ? { env: input.env } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    },
    deps,
  );
}

/**
 * What a phone may learn about a preparation: counts and a skip reason only
 * (never a file name, content or output). 'failed' ends the phone's receipt
 * as a refusal; undefined = nothing declared.
 */
export function phonePrepSummary(result: WorkspacePrepResult): PhoneWorktreePrep | 'failed' | undefined {
  if (result.status === 'none') return undefined;
  if (result.status === 'failed') return 'failed';
  if (result.status === 'skipped') return { status: 'skipped', copied: 0, missing: 0, refused: 0, present: 0, ...(result.reason ? { reason: result.reason } : {}) };
  return { status: 'ready', copied: result.copy.copied, missing: result.copy.missing, refused: result.copy.refused, present: result.copy.present };
}
