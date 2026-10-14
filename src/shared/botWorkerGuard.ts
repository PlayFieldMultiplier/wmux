// ─── The bot-worker merge guard's pure parts, shared by main and the daemon ─
//
// A fan-out worker a bot started merges only through main's merge executor
// (the merge lane, or an approval the owner or a remembered rule gave),
// publishes its branch only through main's push (`task.push`: its own task
// branch, fast-forward only), and leaves every other irreversible or public
// act to an owner approval: claude launches in its pane carry `--settings`
// naming `<wmuxDir>/factory/worker-settings.json`, whose `permissions.deny`
// refuses them (BOT_WORKER_DENY). Main guards the launches it
// types (src/main/agents/botWorkerMergeGuard.ts); the daemon guards the ones a
// phone asks it to type into an existing pane. Both recognise a bot worker's
// pane by `<wmuxDir>/factory/bot-worker-sessions.json`, which only main
// writes; a file that exists but cannot be read counts every pane as a bot
// worker's (fail-closed).
//
// Threat model: this is an intent guard against a confused or misdirected
// model, not isolation. The rules match the commands the agent's own tool
// runs in their usual spellings; a worker runs as the owner's user, so a
// script, an interpreter or another program can still reach the same effects.

import fs from 'node:fs';
import path from 'node:path';
import { tokenize, launcherStem } from './agentResume';
import { splitModelEnvMarker } from './workerLaunch';
import { stripPromptFileArgument } from './promptFileArgument';

/** `gh <group> <verb>` in every spelling gh runs it: with global options
 *  (`-R o/r`, `--repo=o/r`, `--hostname h`) before the group, between the
 *  group and the verb, or both. The verb is a whole word after options, so
 *  `gh pr -R o/r view 3 --json mergeable` is not `merge`. Pure. */
export function ghSubcommandDeny(group: string, verb: string): string[] {
  return [
    `Bash(gh ${group} ${verb}*)`,
    `Bash(gh -* ${group} ${verb}*)`,
    ...['', '-* '].flatMap((pre) => [`Bash(gh ${pre}${group} -* ${verb})`, `Bash(gh ${pre}${group} -* ${verb} *)`]),
  ];
}

/** `gh api<rest>`, also after global options. Pure. */
export function ghApiDeny(rest: string): string[] {
  return [`Bash(gh api${rest})`, `Bash(gh -* api${rest})`];
}

/** The deny rules that send a merge through the lane instead of `gh`. */
export const BOT_WORKER_MERGE_DENY: readonly string[] = [...ghSubcommandDeny('pr', 'merge'), ...ghApiDeny('*merge*')];

/** The default branch names main always treats as a repository's default
 *  branch, whatever its own default branch reads (see the default-branches
 *  file below for the others). Main's push never lands on one. */
export const BOT_WORKER_FALLBACK_DEFAULT_BRANCHES: readonly string[] = ['main', 'master'];

/** Characters a branch name may not hold to read as itself in a rule or a
 *  refspec: git's forbidden ones, the rule syntax's (`*`, parentheses),
 *  quotes, shell expansion and whitespace. */
const UNDENYABLE_CHAR = /[\s~^:?*[\\()"'`$]/u;

/** A branch name that reads as itself in a rule or a refspec: a valid git
 *  branch name (any script) with none of UNDENYABLE_CHAR, not shaped like an
 *  option. */
export function isDenyableBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return !UNDENYABLE_CHAR.test(name) && !name.startsWith('-') && !name.startsWith('.') && !name.startsWith('/')
    && !name.includes('..') && !name.includes('//') && !name.includes('@{') && !name.includes('/.')
    && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && name !== '@';
}

/** Every push: a worker's branch reaches the remote only through main's push
 *  (`task.push`), so the worker's own `git push` is refused in every form —
 *  directly or after git's global options (`-C <dir>`, `-c <key>=<value>`).
 *  Plus what would redirect where main's push lands: a remote's URL, a push
 *  URL or a URL rewrite. */
export const BOT_WORKER_PUSH_DENY: readonly string[] = [
  'Bash(git push)', 'Bash(git push *)', 'Bash(git -* push)', 'Bash(git -* push *)',
  'Bash(git remote set-url*)', 'Bash(git -* remote set-url*)',
  'Bash(git*config*remote.*.push*)', 'Bash(git*config*remote.*.url*)', 'Bash(git*config*url.*)',
];

/** Public acts under the owner's GitHub identity — issues, comments,
 *  reviews, closing or editing a PR, releases, repository settings — and
 *  every `gh api` write (an explicit write method, or fields, which make gh
 *  send a POST). They go to the owner as approval requests
 *  (shared/botApproval.ts). Reads (`gh release view`, a `gh api` GET) pass. */
export const BOT_WORKER_PUBLIC_DENY: readonly string[] = [
  ...['create', 'close', 'comment', 'delete', 'reopen', 'edit', 'transfer', 'lock', 'unlock', 'pin', 'unpin'].flatMap((v) => ghSubcommandDeny('issue', v)),
  ...['comment', 'review', 'close', 'reopen', 'edit', 'lock', 'unlock'].flatMap((v) => ghSubcommandDeny('pr', v)),
  ...['create', 'edit', 'delete', 'upload', 'delete-asset'].flatMap((v) => ghSubcommandDeny('release', v)),
  ...['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'sync'].flatMap((v) => ghSubcommandDeny('repo', v)),
  ...['secret', 'variable'].flatMap((g) => [...ghSubcommandDeny(g, 'set'), ...ghSubcommandDeny(g, 'delete')]),
  ...['POST', 'PATCH', 'PUT', 'DELETE'].flatMap((m) => [m, m.toLowerCase()].flatMap((x) => [...ghApiDeny(`*-X*${x}*`), ...ghApiDeny(`*--method*${x}*`)])),
  ...['* -f*', '* -F*', '*--field*', '*--raw-field*', '*--input*'].flatMap(ghApiDeny),
  // An alias names any of the acts above under another word.
  ...ghSubcommandDeny('alias', 'set'), ...ghSubcommandDeny('alias', 'import'),
];

/** Everything a bot's worker is refused. */
export const BOT_WORKER_DENY: readonly string[] = [...BOT_WORKER_MERGE_DENY, ...BOT_WORKER_PUSH_DENY, ...BOT_WORKER_PUBLIC_DENY];

/** The worker's `--settings` document: every rule. */
export function buildBotWorkerSettings(): Record<string, unknown> {
  return { permissions: { deny: [...BOT_WORKER_DENY] } };
}

// ── factory/worker-default-branches.json ─────────────────────────────────────
// The default branches of the repositories bots' workers run in, as main read
// them (GitHub's default branch, else origin/HEAD). Only main writes and reads
// it: main's push (`task.push`) never lands on one. Missing or unreadable:
// main/master only.

export const BOT_WORKER_DEFAULT_BRANCHES_VERSION = 1;
/** Most names kept (oldest dropped first). */
export const BOT_WORKER_DEFAULT_BRANCHES_MAX = 64;

export function botWorkerDefaultBranchesPath(dir: string): string {
  return path.join(dir, 'factory', 'worker-default-branches.json');
}

/** The recorded default branches (valid names only, main/master left out). */
export function readBotWorkerDefaultBranches(dir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(botWorkerDefaultBranchesPath(dir), 'utf8')) as { version?: unknown; branches?: unknown };
    if (raw?.version !== BOT_WORKER_DEFAULT_BRANCHES_VERSION || !Array.isArray(raw.branches)) return [];
    const names = raw.branches.filter((b): b is string => isDenyableBranchName(b) && !BOT_WORKER_FALLBACK_DEFAULT_BRANCHES.includes(b));
    return [...new Set(names)].slice(-BOT_WORKER_DEFAULT_BRANCHES_MAX);
  } catch {
    return [];
  }
}

/** Main: add one repository's default branch (written whole, only when it
 *  is new). False when the name cannot be held (isDenyableBranchName) or the
 *  file cannot be written; main/master need no record. */
export function recordBotWorkerDefaultBranch(dir: string, name: string): boolean {
  if (!isDenyableBranchName(name)) return false;
  if (BOT_WORKER_FALLBACK_DEFAULT_BRANCHES.includes(name)) return true;
  const known = readBotWorkerDefaultBranches(dir);
  if (known.includes(name)) return true;
  const branches = [...known, name].slice(-BOT_WORKER_DEFAULT_BRANCHES_MAX);
  const file = botWorkerDefaultBranchesPath(dir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify({ version: BOT_WORKER_DEFAULT_BRANCHES_VERSION, branches })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return false;
  }
}

/**
 * A path that reads back byte-identical from inside double quotes on a POSIX,
 * PowerShell or cmd line: no quotes, no `$`/backtick (POSIX and PowerShell
 * expand them), no `%`/`!` (cmd expands them), and no run of backslashes
 * (POSIX collapses `\\` to `\`). Anything else could make the file written
 * and the path passed to --settings differ.
 */
export function isQuotable(p: string): boolean {
  return !/['"`$%!]/.test(p) && !/\\\\/.test(p);
}

/** The settings file's path under the instance data dir. */
export function botWorkerSettingsPath(dir: string): string {
  return path.join(dir, 'factory', 'worker-settings.json');
}

/**
 * Write the worker settings under `<dir>/factory/` (rewritten only when they
 * drift) and return the path. The file is replaced whole (a temporary file
 * renamed over it), so a worker starting meanwhile reads the old or the new
 * content, never a partial one. Throws when it cannot be written.
 */
export function writeBotWorkerSettings(dir: string): string {
  const file = botWorkerSettingsPath(dir);
  const content = `${JSON.stringify(buildBotWorkerSettings(), null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.readFileSync(file, 'utf8') === content) return file;
  } catch {
    /* missing: write it */
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}

/**
 * One plain command: no unquoted command separator, pipe, background `&`,
 * comment, command substitution or line break. The prompt argument's
 * double-quoted `$(...)` (FanOutService.buildInitialCommand) is quoted and
 * passes; a line that could start a second program does not.
 */
export function isSingleCommand(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (/[;&|#`\n\r]/.test(c) || (c === '$' && command[i + 1] === '(')) return false;
  }
  return quote === null;
}

/** Command or process substitution, quoted or not. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

function isClaudeLauncher(word: string): boolean {
  return launcherStem(word) === 'claude';
}

/**
 * Splice `--settings="<path>"` right after a `claude` launcher, keeping a
 * leading model-env marker. Returns the line unchanged when this file is
 * already the launcher's first argument and no other settings flag follows,
 * and null when it cannot carry it: another launcher, an empty line, more than
 * one command, an end-of-options `--`, another `--settings`, or a path that
 * cannot be quoted.
 */
export function spliceSettingsFlag(fullCommand: string, settingsPath: string): string | null {
  const { marker, command } = splitModelEnvMarker(fullCommand);
  if (!isQuotable(settingsPath)) return null;
  // The prompt-file argument fan-out builds (FanOutService.buildInitialCommand)
  // is the one substitution a launch line may hold, by its exact shape.
  const rest = stripPromptFileArgument(command);
  if (SUBSTITUTION.test(rest) || !isSingleCommand(rest)) return null;
  const tokens = tokenize(command);
  if (tokens.length === 0 || !isClaudeLauncher(tokens[0].value)) return null;
  if (tokens.some((t) => t.value === '--')) return null;
  const ours = `--settings=${settingsPath}`;
  // Quoting does not hide a flag from the shell, so a quoted one counts too.
  const passed = tokens.slice(1).filter((t) => /^--settings(=|$)/.test(t.value));
  if (passed.length > 0) return passed.length === 1 && tokens[1] === passed[0] && passed[0].value === ours ? fullCommand : null;
  // The `=` form, like --mcp-config in toolSurfaceLaunch: one word on both shells.
  const at = tokens[0].end;
  return `${marker}${command.slice(0, at)} --settings="${settingsPath}"${command.slice(at)}`;
}

/** Does any word of the line start claude? */
export function namesClaude(line: string): boolean {
  return tokenize(splitModelEnvMarker(line).command).some((t) => isClaudeLauncher(t.value));
}

// ── factory/bot-worker-sessions.json ─────────────────────────────────────────

export const BOT_WORKER_SESSIONS_VERSION = 1;

export interface BotWorkerSessionRecord { workspaceId: string; at: number }

export function botWorkerSessionsPath(dir: string): string {
  return path.join(dir, 'factory', 'bot-worker-sessions.json');
}

/** Read the sessions record now: its sessions (none when the file is
 *  missing), or why it is unreadable. Never cached here. */
export function readBotWorkerSessions(dir: string): { sessions: Map<string, BotWorkerSessionRecord> } | { unreadable: string } {
  const out = new Map<string, BotWorkerSessionRecord>();
  try {
    const raw = JSON.parse(fs.readFileSync(botWorkerSessionsPath(dir), 'utf8')) as { version?: unknown; sessions?: unknown };
    if (raw?.version !== BOT_WORKER_SESSIONS_VERSION || !raw.sessions || typeof raw.sessions !== 'object') throw new Error('not a version 1 sessions file');
    for (const [id, rec] of Object.entries(raw.sessions as Record<string, unknown>)) {
      const r = rec as Partial<BotWorkerSessionRecord> | null;
      if (!id || typeof r?.workspaceId !== 'string' || typeof r.at !== 'number') throw new Error(`a malformed record (${id})`);
      out.set(id, { workspaceId: r.workspaceId, at: r.at });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { unreadable: String(err) };
  }
  return { sessions: out };
}
