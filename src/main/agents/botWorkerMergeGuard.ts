// ─── A bot's fan-out worker merges only through the merge lane ──────────────
//
// The agent factory's merge lane (moaMergeLane.ts) is the one merger of a
// bot's pull requests: its predicates read fresh facts and it runs no model.
// A fan-out worker a bot started therefore launches with its OWN `--settings`
// file, never the owner's user settings, whose `permissions.deny` refuses
// `gh pr merge` and the `gh api` merge endpoints, force pushes and pushes to
// a default branch, and public `gh` acts (shared/botWorkerGuard.ts
// BOT_WORKER_DENY) — at the fan-out launch, on a
// resume typed into its pane, and on a re-fire, across app restarts. Workers a
// person started (a pane, the GUI, an orchestrator) launch exactly as before.
//
// A codex worker is launched as the fan-out's own first launch, on the line
// its own guard rebuilt (codexWorkerGuard.ts), which records where; a re-fire
// or a typed resume in that pane goes through the codex guard again from the
// record. The sync stages here refuse every codex line (a later pane, the
// factory's worker resume).
//
// Fail-closed: a bot worker's launch line that cannot carry the file (it could
// not be written, the path cannot be quoted, the launcher is not claude or a
// guarded codex, the line is more than one plain command or holds a
// substitution, or it already names another settings file) is not run. pty:create throws (the renderer
// rolls the workspace back and the fan-out reports the task as not launched);
// a resume or re-fire types nothing.
//
// Measured on claude 2.1.292 (interactive TUI, a local fake Messages API):
// `Bash(gh pr merge*)` and `Bash(gh api*merge*)` hold under
// --dangerously-skip-permissions, including a compound line
// (`cd x && gh pr merge 3`); `gh pr view` and a plain `gh api` read pass.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import {
  BOT_WORKER_SESSIONS_VERSION,
  botWorkerSessionsPath,
  namesClaude,
  readBotWorkerSessions,
  spliceSettingsFlag,
  writeBotWorkerSettings,
  type BotWorkerSessionRecord,
} from '../../shared/botWorkerGuard';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { launchesCodex, namesCodex } from '../../shared/codexWorkerGuard';

// The pure parts live in shared/ (the daemon guards a phone's launches too).
export {
  BOT_WORKER_DENY,
  BOT_WORKER_MERGE_DENY,
  botWorkerSessionsPath,
  botWorkerSettingsPath,
  buildBotWorkerSettings,
  isQuotable,
  isSingleCommand,
  spliceSettingsFlag,
  writeBotWorkerSettings,
} from '../../shared/botWorkerGuard';

export interface BotWorkerGuardDeps {
  /** The instance data dir (default: getWmuxDir()). */
  dir?: string;
  writeSettings?: (dir: string) => string;
  /** Main's ledger: is this workspace a bot's fan-out task? */
  isBotTaskWorkspace?: (workspaceId: string) => boolean;
}

// ── Which panes are a bot's workers: main's own records, never the renderer's
// echo of the fan-out origin.
//
//  - The fan-out create: FanOutService marks the spawn it is running for a bot
//    (owner workspace + worktree) for the length of the renderer round trip.
//  - Any later create in that task workspace (a replaced dead pane, a new
//    tab): the task ledger row main registered at dispatch.
//  - Every session either created: factory/bot-worker-sessions.json, so a
//    re-fire or a resume after an app restart still knows the pane.

const inflightBotSpawns = new Map<string, number>();
/** Who each in-flight bot spawn is for (bot and task), main's own record:
 *  a secret grant resolves only for a spawn whose identity matches it. */
export interface BotSpawnIdentity { botId: string; taskId: string }
const inflightSpawnIdentities = new Map<string, BotSpawnIdentity[]>();
const spawnKey = (ownerWorkspaceId: string, cwd: string): string => `${ownerWorkspaceId}\u0000${path.resolve(cwd)}`;

/** FanOutService, around the renderer spawn of a bot's worker. Returns the
 *  release. */
export function beginBotWorkerSpawn(ownerWorkspaceId: string, cwd: string, identity?: BotSpawnIdentity): () => void {
  const key = spawnKey(ownerWorkspaceId, cwd);
  inflightBotSpawns.set(key, (inflightBotSpawns.get(key) ?? 0) + 1);
  const mark = identity ? { botId: identity.botId, taskId: identity.taskId } : null;
  if (mark) inflightSpawnIdentities.set(key, [...(inflightSpawnIdentities.get(key) ?? []), mark]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mark) {
      const left = (inflightSpawnIdentities.get(key) ?? []).filter((m) => m !== mark);
      if (left.length > 0) inflightSpawnIdentities.set(key, left);
      else inflightSpawnIdentities.delete(key);
    }
    const n = (inflightBotSpawns.get(key) ?? 1) - 1;
    if (n > 0) inflightBotSpawns.set(key, n);
    else {
      inflightBotSpawns.delete(key);
      codexLaunched.delete(key);
    }
  };
}

/** In-flight spawns (by spawnKey) whose one codex launch was claimed. */
const codexLaunched = new Set<string>();

/** codexWorkerGuard: the in-flight fan-out spawn of `ownerWorkspaceId` in
 *  `cwd` launches codex once; true for that one claim, false otherwise. */
export function claimInflightCodexLaunch(ownerWorkspaceId: string, cwd: string): boolean {
  const key = spawnKey(ownerWorkspaceId, cwd);
  if (!ownerWorkspaceId || !inflightBotSpawns.has(key) || codexLaunched.has(key)) return false;
  codexLaunched.add(key);
  return true;
}

/** The creates whose codex line codexWorkerGuard built, with the line and the
 *  folder it checked (main's own memory, per options object: a renderer cannot
 *  put an entry here, and an entry goes with its create). */
const guardedCodexCreates = new WeakMap<object, { line: string; cwd: string; repoKey?: string; codexHome?: string }>();

/** codexWorkerGuard: record a create it built. */
export function markGuardedCodexCreate(options: object, line: string, cwd: string, repoKey?: string, codexHome?: string): void {
  guardedCodexCreates.set(options, { line, cwd: path.resolve(cwd), ...(repoKey ? { repoKey } : {}), ...(codexHome ? { codexHome } : {}) });
}

/** pty:create: what the session record keeps of a guarded codex create. */
export function guardedCodexLaunch(options: object | undefined): { agent: string; cwd: string; repoKey?: string; codexHome?: string } | undefined {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  return g ? { agent: 'codex', cwd: g.cwd, ...(g.repoKey ? { repoKey: g.repoKey } : {}), ...(g.codexHome ? { codexHome: g.codexHome } : {}) } : undefined;
}

/** Did the codex guard build this create's line? */
export function isGuardedCodexCreate(options: { initialCommand?: string } | undefined): boolean {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  return !!g && g.line === options?.initialCommand;
}

/**
 * pty:create, once the folder is resolved: a guarded codex create starts in
 * the folder it was checked in, or not at all (never a recovery folder or the
 * home fallback). Null when it may start, and for every other create.
 */
export function guardedCodexCwdRefusal(
  options: { initialCommand?: string } | undefined,
  resolution: { source: string; safeCwd?: string | null },
): string | null {
  const g = options ? guardedCodexCreates.get(options) : undefined;
  if (!g) return null;
  if (resolution.source !== 'requested' || !resolution.safeCwd || path.resolve(resolution.safeCwd) !== g.cwd) {
    return 'PTY_CREATE: a bot\'s codex worker starts only in the folder its rules were written into';
  }
  return null;
}

function ledgerSaysBot(workspaceId: string): boolean {
  return getTaskLedger().findByTaskWorkspace(workspaceId)?.dispatch?.origin?.kind === 'bot';
}

/** What pty:create is creating, for the guard: a bot's worker (`strict` for
 *  the fan-out launch itself) in `workspaceId`, or null. */
export interface BotWorkerCreate {
  workspaceId: string;
  strict: boolean;
  /** The fan-out launch only: who the in-flight spawns of this owner and
   *  folder are for (main's record, never the renderer's). */
  spawns?: BotSpawnIdentity[];
}

export function botWorkerForCreate(
  options: { workspaceId?: unknown; cwd?: unknown; fanoutTaskOf?: unknown } | undefined,
  deps: BotWorkerGuardDeps = {},
): BotWorkerCreate | null {
  if (!options) return null;
  const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
  const owner = typeof options.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  if (owner && typeof options.cwd === 'string' && options.cwd && inflightBotSpawns.has(spawnKey(owner, options.cwd))) {
    const spawns = inflightSpawnIdentities.get(spawnKey(owner, options.cwd));
    return { workspaceId, strict: true, ...(spawns ? { spawns: spawns.map((s) => ({ ...s })) } : {}) };
  }
  if (!workspaceId) return null;
  let bot = false;
  try {
    bot = (deps.isBotTaskWorkspace ?? ledgerSaysBot)(workspaceId);
  } catch (err) {
    throw guardError('PTY_CREATE', `the task ledger could not be read: ${String(err)}`);
  }
  // The sessions record too, for a workspace whose ledger row is gone.
  if (!bot) bot = isBotWorkerWorkspace(workspaceId, deps.dir ?? getWmuxDir());
  return bot ? { workspaceId, strict: !!owner } : null;
}

/**
 * pty:create's stage. Returns `options` itself for every create that is not a
 * bot's worker. The fan-out launch of a bot's worker gets its guarded launch
 * line, or this throws (the create fails). Any other create in a bot's task
 * workspace gets a claude launch line guarded the same way, and anything else
 * (a plain shell, no line) unchanged.
 */
export function withBotWorkerMergeGuard<T extends { initialCommand?: string; exec?: unknown }>(
  options: T | undefined,
  worker: BotWorkerCreate | null,
  deps: BotWorkerGuardDeps = {},
): T | undefined {
  if (!options || !worker) return options;
  if (worker.strict) {
    if (options.exec !== undefined) throw guardError('PTY_CREATE', 'an exec unit has no launch line to guard');
    if (!options.initialCommand) throw guardError('PTY_CREATE', 'no launch line');
    // A codex worker's line is rebuilt by its own guard (codexWorkerGuard.ts),
    // which ran first; any other codex line is refused.
    if (launchesCodex(options.initialCommand)) {
      if (isGuardedCodexCreate(options)) return options;
      throw guardError('PTY_CREATE', 'a codex launch line the codex worker guard did not build');
    }
  } else if (options.initialCommand && namesCodex(options.initialCommand)) {
    throw guardError('PTY_CREATE', 'codex runs in a bot\'s worker pane only as the fan-out\'s own first launch');
  } else if (!options.initialCommand || !namesClaude(options.initialCommand)) {
    return options;
  }
  const initialCommand = guardLaunchLine('PTY_CREATE', options.initialCommand, deps);
  return initialCommand === options.initialCommand ? options : { ...options, initialCommand };
}

/** The POSIX shells whose `clear; <line>` clears the screen first. */
const CLEARING_SHELL = /(^|[\\/])(sh|bash|zsh|dash|ksh|fish)$/;

/**
 * A bot worker's typed launch line, cleared from the screen before it runs:
 * `clear; <line>`, so the pane (shown on the Bots page) starts at the agent's
 * own screen instead of the shell's echo of a long command line. Only for a
 * POSIX shell the line is typed into (a WSL or Windows shell keeps the line
 * as it is). Typed at write time, after every stage that reads the line, so
 * the flags, the guard and the session pin are untouched. Pure.
 */
export function clearedLaunchLine(line: string | undefined, shell: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!line || line.trim().length === 0 || platform === 'win32') return line;
  return CLEARING_SHELL.test(shell.trim()) ? `clear; ${line}` : line;
}

function guardError(where: string, why: string): Error {
  return new Error(`${where}: a bot's fan-out worker starts only with the merge-lane guard (${why})`);
}

function guardLaunchLine(where: string, line: string, deps: BotWorkerGuardDeps): string {
  let settingsPath: string;
  try {
    settingsPath = (deps.writeSettings ?? writeBotWorkerSettings)(deps.dir ?? getWmuxDir());
  } catch (err) {
    throw guardError(where, `the worker settings could not be written: ${String(err)}`);
  }
  const guarded = spliceSettingsFlag(line, settingsPath);
  if (guarded === null) throw guardError(where, 'the launch line cannot carry the worker settings');
  return guarded;
}

// ── factory/bot-worker-sessions.json ─────────────────────────────────────────

type SessionRecord = BotWorkerSessionRecord;

// A record kept until its pane is closed. `unreadable`: the file exists but
// could not be read; every session then counts as a bot worker's, and
// nothing new is recorded over it.
let sessions: Map<string, SessionRecord> | null = null;
let sessionsDir: string | null = null;
let unreadable: string | null = null;

function loadSessions(dir: string): Map<string, SessionRecord> {
  if (sessions && sessionsDir === dir) return sessions;
  const read = readBotWorkerSessions(dir);
  unreadable = 'unreadable' in read ? read.unreadable : null;
  if (unreadable) console.warn(`[factory] ${botWorkerSessionsPath(dir)} is unreadable; every pane's launch line is guarded until it is fixed: ${unreadable}`);
  sessions = 'sessions' in read ? read.sessions : new Map();
  sessionsDir = dir;
  return sessions;
}

function saveSessions(dir: string, map: Map<string, SessionRecord>): void {
  const file = botWorkerSessionsPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify({ version: BOT_WORKER_SESSIONS_VERSION, sessions: Object.fromEntries(map) })}\n`;
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** pty:create records a bot worker's session. Throws when the record cannot
 *  be written (the create fails: a session nobody could recognise after a
 *  restart is not started). */
export function noteBotWorkerSession(
  sessionId: string,
  workspaceId: string,
  dir: string = getWmuxDir(),
  /** A guarded codex launch: where, and for which repository. */
  launch?: { agent: string; cwd: string; repoKey?: string; codexHome?: string },
): void {
  const map = loadSessions(dir);
  if (unreadable) throw guardError('PTY_CREATE', `the worker sessions record is unreadable: ${unreadable}`);
  const next = new Map(map);
  next.set(sessionId, { workspaceId, at: Date.now(), ...(launch ?? {}) });
  try {
    saveSessions(dir, next);
  } catch (err) {
    throw guardError('PTY_CREATE', `the worker session could not be recorded: ${String(err)}`);
  }
  map.set(sessionId, next.get(sessionId)!);
}

/** The pane is gone. Best-effort: a record left behind only keeps guarding. */
export function forgetBotWorkerSession(sessionId: string, dir: string = getWmuxDir()): void {
  const map = loadSessions(dir);
  if (unreadable || !map.has(sessionId)) return;
  const next = new Map(map);
  next.delete(sessionId);
  try {
    saveSessions(dir, next);
    map.delete(sessionId);
  } catch (err) {
    console.warn(`[factory] could not forget bot worker session ${sessionId}: ${String(err)}`);
  }
}

/** A bot worker's session record, or null (none, or the record is unreadable). */
export function botWorkerSessionRecord(sessionId: string, dir: string = getWmuxDir()): SessionRecord | null {
  const map = loadSessions(dir);
  if (unreadable !== null) return null;
  const r = map.get(sessionId);
  return r ? { ...r } : null;
}

/** A bot worker's session — every session while the record is unreadable. */
export function isBotWorkerSession(sessionId: string, dir: string = getWmuxDir()): boolean {
  const map = loadSessions(dir);
  return unreadable !== null || map.has(sessionId);
}

/** A workspace a bot worker's session was recorded in (any, while unreadable). */
function isBotWorkerWorkspace(workspaceId: string, dir: string): boolean {
  const map = loadSessions(dir);
  if (unreadable !== null) return true;
  for (const r of map.values()) if (r.workspaceId === workspaceId) return true;
  return false;
}

/** Tests: drop the in-memory copy, as an app restart does. */
export function reloadBotWorkerSessionsForTests(): void {
  sessions = null;
  sessionsDir = null;
  unreadable = null;
}

/**
 * worktask:refire's stage: the line to re-type into `sessionId`. A bot
 * worker's session gets the guarded line, or this throws (nothing is typed);
 * any other session gets `line` unchanged.
 */
export function guardRefireLine(sessionId: string, line: string, deps: BotWorkerGuardDeps = {}): string {
  if (!isBotWorkerSession(sessionId, deps.dir ?? getWmuxDir())) return line;
  if (namesCodex(line)) throw guardError('worktask:refire', 'codex is not re-fired in a bot\'s worker pane');
  return guardLaunchLine('worktask:refire', line, deps);
}

/**
 * pty:write-launch's stage (a resume line typed into a pane, or the start of
 * one): in a bot worker's session, text that starts claude gets the guard or
 * this throws (nothing is typed). Text that names no claude launcher (the
 * second half of a staged resume) and every other session pass unchanged.
 */
export function guardSessionLaunch(sessionId: string, text: string, deps: BotWorkerGuardDeps = {}): string {
  if (!isBotWorkerSession(sessionId, deps.dir ?? getWmuxDir())) return text;
  if (namesCodex(text)) throw guardError('pty:write-launch', 'codex is not started again in a bot\'s worker pane');
  if (!namesClaude(text)) return text;
  return guardLaunchLine('pty:write-launch', text, deps);
}
