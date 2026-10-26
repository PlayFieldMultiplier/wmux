// ─── Custom agents (Settings → Roles & fan-out → Custom agents) ──────────────
//
// An agent CLI wmux does not know, defined by the operator so a role binding or
// a fan-out preset row can launch it. Operator data, kept main-side like the
// fan-out presets (src/main/worktask/customAgents.ts): only the Settings IPC
// writes it. No A2A, phone or remote-spawn path can define one, and a caller's
// own `agents[k]` cannot name one either; it is reached through the operator's
// presets and role bindings only.
//
// A custom agent is referenced by its launcher stem (the Command's basename,
// lower-cased, `.exe`/`.cmd` dropped), the same key a registry agent's role
// binding or preset row carries. The validator keeps that stem apart from every
// registry agent and from the other custom agents, so a reference is never
// ambiguous.
//
// What it is NOT given: no screen status, approval cards, hooks or resume, and
// never an implicit unattended or permission flag. Its unattended flags are
// exactly what the operator typed, added only when a preset row turns
// Unattended on; an empty field means fan-out does not offer Unattended.

import { AGENT_ROWS, agentLauncherStem } from './agentIdentity';
import { launcherStem } from './agentResume';

export interface CustomAgent {
  /** Display name, unique (case-insensitive) among custom agents. */
  name: string;
  /** A program name on PATH, or an absolute path the operator typed. */
  command: string;
  /** Launch arguments, each a plain token. */
  args?: string;
  /** The flag the first prompt goes after; absent = the prompt is positional. */
  promptFlag?: string;
  /** `<modelFlag> <model>` pins a model; absent = no model pin. */
  modelFlag?: string;
  /** Inserted only when a preset row turns Unattended on; absent = not offered. */
  unattendedFlags?: string;
}

export type CustomAgentIssueCode =
  | 'not-object'
  | 'unknown-field'
  | 'name-invalid'
  | 'name-duplicate'
  | 'command-invalid'
  | 'command-separator'
  | 'command-known'
  | 'command-generic'
  | 'command-duplicate'
  | 'args-invalid'
  | 'flag-invalid'
  | 'agents-not-array'
  | 'agents-over-cap'
  | 'agent-in-use'
  | 'args-flag'
  | 'command-posix-path'
  | 'model-in-use'
  | 'unattended-in-use';

export interface CustomAgentIssue {
  code: CustomAgentIssueCode;
  params: Record<string, string>;
  /** English, for the wire and logs. */
  error: string;
}

function issue(code: CustomAgentIssueCode, params: Record<string, string>, error: string): CustomAgentIssue {
  return { code, params, error };
}

export const CUSTOM_AGENTS_MAX = 16;
export const CUSTOM_AGENT_NAME_MAX = 40;
export const CUSTOM_AGENT_COMMAND_MAX = 260;
export const CUSTOM_AGENT_ARGS_MAX = 200;
export const CUSTOM_AGENT_FLAG_MAX = 64;
/** A role binding or preset row stores the stem in a field capped at 48
 *  characters (orchestratorRole ROLE_BINDING_AGENT_MAX): a longer program name
 *  could be saved but never referenced. */
export const CUSTOM_AGENT_STEM_MAX = 48;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
/** A program name with no folder: what PATH lookup takes. */
const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** An absolute path: `/…` or a drive-letter path. No spaces, quotes or shell
 *  syntax, so the path is one shell word on every pane shell. */
const POSIX_ABSOLUTE_RE = /^\/[A-Za-z0-9._+/-]+$/;
const WIN_ABSOLUTE_RE = /^[A-Za-z]:[\\/][A-Za-z0-9._+\\/-]+$/;
/** One argument or flag: no quotes, spaces, `$`, backticks, `;|&<>`, globs,
 *  `~`, `\` or brackets, so it reaches the CLI as typed on every pane shell.
 *  Nor what PowerShell or cmd still reads in a bare word: `%` (cmd's `%VAR%`,
 *  PowerShell's stop-parsing `--%`) and `,` (a PowerShell array); and no
 *  leading `@` (splatting) or `=` (zsh's path expansion). */
const TOKEN_RE = /^[A-Za-z0-9+:._/-][A-Za-z0-9@+=:._/-]*$/;
/** A flag name: a leading `-`, then the token alphabet. */
const FLAG_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Programs that run something else: a custom agent launched as `node x.js`
 * would get its model and unattended flags right after `node`, before the
 * script, and every `node` line typed in a bound pane would read as that
 * agent. Such an agent goes through a wrapper on PATH instead.
 */
const GENERIC_COMMANDS: ReadonlySet<string> = new Set([
  'nodejs', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'tsx', 'ts-node', 'py', 'pip', 'pipx', 'uv', 'uvx',
  'poetry', 'conda', 'java', 'cargo', 'go', 'dotnet', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'busybox', 'env',
  'sudo', 'nohup', 'xargs', 'timeout', 'ssh', 'docker', 'podman', 'wsl', 'git', 'wmux',
]);
/** The interpreters and shells, with any version suffix (`python3.12`, `node22`, `pypy3`). */
const VERSIONED_GENERIC_RE = /^(python|pythonw|pypy|node|perl|ruby|php|bash|sh|zsh|pwsh|powershell|cmd|deno|bun)[\d.]*$/;

function isGenericCommand(stem: string): boolean {
  return GENERIC_COMMANDS.has(stem) || VERSIONED_GENERIC_RE.test(stem);
}

/** A name as the matching rules compare it: basename, lower-cased, a Windows
 *  executable extension dropped, and trailing dots and spaces dropped first,
 *  since Windows ignores them (`codex.exe.` runs codex). */
function matchStem(name: string): string {
  return launcherStem(name.trim().replace(/[. ]+$/, ''));
}

/**
 * Every name a registry agent is known by: its slug, its launcher stem, and the
 * native executable names the process tracker matches. A custom stem equal to
 * one would make a role binding or preset row ambiguous.
 */
const REGISTRY_NAMES: ReadonlySet<string> = new Set(
  AGENT_ROWS.flatMap((row) => [
    row.slug,
    agentLauncherStem(row),
    ...(row.process?.executables ?? []),
  ].map((n) => matchStem(n))),
);

/** The key a role binding or preset row uses for this agent. */
export function customAgentStem(agent: Pick<CustomAgent, 'command'>): string {
  return matchStem(agent.command);
}

/** The custom agent a stem names, if any. */
export function findCustomAgent(stem: string, list: readonly CustomAgent[] | undefined): CustomAgent | undefined {
  if (!list || !stem) return undefined;
  const key = stem.toLowerCase();
  return list.find((a) => customAgentStem(a) === key);
}

/** What replaces the launcher token when a role or preset row picks it. */
export function customAgentLaunchLine(agent: CustomAgent): string {
  return agent.args ? `${agent.command} ${agent.args}` : agent.command;
}

/**
 * How many of `agent`'s own Arguments follow the launcher on a line, as
 * tokens (`values[0]` is the launcher; a quoted token is passed as null): all
 * of them, in order, or 0. They are part of what launches the agent (a
 * subcommand such as `chat`), so the role rewrite places its flags after them
 * and never reads them as prose.
 */
export function customLaunchPrefixLength(values: readonly (string | null)[], agent: CustomAgent): number {
  const args = agent.args ? agent.args.split(' ') : [];
  if (args.length === 0 || values.length < 1 + args.length) return 0;
  return args.every((a, i) => values[1 + i] === a) ? args.length : 0;
}

/** Lookup key for a custom agent's name. */
export function customAgentNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function tokensOk(value: string): boolean {
  return value.split(' ').every((t) => TOKEN_RE.test(t));
}

/** `flag` itself, or `flag=<value>`, on a token. */
export function isFlagToken(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}

/** Where a definition is used: the pane shell it will run in. */
export interface CustomAgentPlatform {
  /** `process.platform` of the machine the panes run on; unknown = no
   *  platform-specific rule. */
  platform?: string;
}

/** Collapse whitespace runs: fields are space-separated token lists. */
function squash(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

const FIELDS = new Set(['name', 'command', 'args', 'promptFlag', 'modelFlag', 'unattendedFlags']);

/**
 * One custom agent from untrusted input (the Settings save, or a hand-edited
 * file), on its own. The list rules (unique name and stem, the cap) are
 * {@link validateCustomAgents}'.
 */
export function normalizeCustomAgent(
  input: unknown,
  opts: CustomAgentPlatform = {},
): { ok: true; agent: CustomAgent } | ({ ok: false } & CustomAgentIssue) {
  const fail = (i: CustomAgentIssue): { ok: false } & CustomAgentIssue => ({ ok: false, ...i });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(issue('not-object', {}, 'custom agent must be an object'));
  }
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!FIELDS.has(key)) {
      const field = key.slice(0, 40);
      return fail(issue('unknown-field', { field }, `unknown field "${field}"`));
    }
  }
  const name = squash(src.name);
  const nameMax = String(CUSTOM_AGENT_NAME_MAX);
  if (!name || name.length > CUSTOM_AGENT_NAME_MAX || !NAME_RE.test(name)) {
    return fail(issue('name-invalid', { max: nameMax }, `name must be 1-${nameMax} characters: letters, digits, space . _ -`));
  }

  // A field of the wrong type is refused, never read as absent: the agent
  // would load with part of its definition silently missing.
  for (const field of ['command', 'args', 'promptFlag', 'modelFlag', 'unattendedFlags'] as const) {
    if (src[field] !== undefined && typeof src[field] !== 'string') {
      return fail(issue(field === 'args' ? 'args-invalid' : field === 'command' ? 'command-invalid' : 'flag-invalid',
        { name, field, command: '', max: String(CUSTOM_AGENT_ARGS_MAX) }, `"${name}": ${field} must be text`));
    }
  }
  const command = typeof src.command === 'string' ? src.command.trim() : '';
  const shown = command.slice(0, 80);
  // A trailing dot or space is dropped by Windows when it runs the program,
  // but stays in the line wmux matches the agent on; refuse it outright.
  if (!command || command.length > CUSTOM_AGENT_COMMAND_MAX || /[. ]$/.test(command)) {
    return fail(issue('command-invalid', { name, command: shown }, `"${name}": command must be a program name or an absolute path`));
  }
  if (!BARE_COMMAND_RE.test(command)) {
    // `//host/share/x` is a UNC path on Windows: never a local program.
    const absolute = (POSIX_ABSOLUTE_RE.test(command) && !command.startsWith('//')) || WIN_ABSOLUTE_RE.test(command);
    const hasDotSegment = command.split(/[\\/]/).some((seg) => seg === '..' || seg === '.');
    if (!absolute || hasDotSegment) {
      // A folder in a relative name is the case the separator rule is for; the
      // rest is shell syntax, spaces or quotes.
      const relativePath = /[\\/]/.test(command) && !/[\s'"`$;|&<>*?~(){}[\]!#]/.test(command);
      return fail(
        relativePath
          ? issue('command-separator', { name, command: shown }, `"${name}": "${shown}" has a folder but is not an absolute path`)
          : issue('command-invalid', { name, command: shown }, `"${name}": command must be a program name or an absolute path, with no spaces or shell syntax`),
      );
    }
  }
  // On Windows `/tools/tern` resolves against whatever drive is current.
  if (opts.platform === 'win32' && command.startsWith('/')) {
    return fail(issue('command-posix-path', { name, command: shown }, `"${name}": "${shown}" is not a Windows path; type it with its drive (C:\\…)`));
  }
  const stem = matchStem(command);
  if (!BARE_COMMAND_RE.test(stem) || stem.length > CUSTOM_AGENT_STEM_MAX) {
    return fail(issue('command-invalid', { name, command: shown }, `"${name}": command must be a program name or an absolute path`));
  }
  if (REGISTRY_NAMES.has(stem)) {
    return fail(issue('command-known', { name, stem }, `"${name}": "${stem}" is an agent wmux already knows`));
  }
  if (isGenericCommand(stem)) {
    return fail(issue('command-generic', { name, stem }, `"${name}": "${stem}" runs other programs; use a wrapper on PATH that starts the agent`));
  }

  const args = squash(src.args);
  if (args.length > CUSTOM_AGENT_ARGS_MAX || (args && !tokensOk(args))) {
    return fail(issue('args-invalid', { name, max: String(CUSTOM_AGENT_ARGS_MAX) }, `"${name}": arguments must be plain words (no quotes, spaces inside one, or shell syntax)`));
  }

  const agent: CustomAgent = { name, command };
  if (args) agent.args = args;
  for (const field of ['promptFlag', 'modelFlag'] as const) {
    const flag = squash(src[field]);
    if (!flag) continue;
    if (flag.length > CUSTOM_AGENT_FLAG_MAX || !FLAG_RE.test(flag)) {
      return fail(issue('flag-invalid', { name, field }, `"${name}": ${field} must be one flag, such as --model`));
    }
    agent[field] = flag;
  }
  const unattended = squash(src.unattendedFlags);
  if (unattended) {
    if (unattended.length > CUSTOM_AGENT_ARGS_MAX || !tokensOk(unattended) || !unattended.startsWith('-')) {
      return fail(issue('flag-invalid', { name, field: 'unattendedFlags' }, `"${name}": unattendedFlags must be plain flags`));
    }
    agent.unattendedFlags = unattended;
  }
  // Its own model or prompt flag in the arguments would fight the one wmux
  // places: the arguments' value wins on the line while wmux reports the pin,
  // or the pin reads as already given and is never placed.
  for (const flag of [agent.modelFlag, agent.promptFlag]) {
    if (flag && args.split(' ').some((t) => isFlagToken(t, flag))) {
      return fail(issue('args-flag', { name, flag }, `"${name}": the arguments already carry ${flag}; wmux places it itself`));
    }
  }
  return { ok: true, agent };
}

/** Strict, for a save: the first problem is reported and nothing is kept. */
export function validateCustomAgents(
  input: unknown,
  opts: CustomAgentPlatform = {},
): { ok: true; agents: CustomAgent[] } | ({ ok: false } & CustomAgentIssue) {
  if (!Array.isArray(input)) return { ok: false, ...issue('agents-not-array', {}, 'custom agents must be an array') };
  if (input.length > CUSTOM_AGENTS_MAX) {
    const cap = String(CUSTOM_AGENTS_MAX);
    return { ok: false, ...issue('agents-over-cap', { cap }, `at most ${cap} custom agents`) };
  }
  const agents: CustomAgent[] = [];
  for (const raw of input) {
    const r = normalizeCustomAgent(raw, opts);
    if (!r.ok) return r;
    const clash = listClash(r.agent, agents);
    if (clash) return { ok: false, ...clash };
    agents.push(r.agent);
  }
  return { ok: true, agents };
}

function listClash(agent: CustomAgent, kept: readonly CustomAgent[]): CustomAgentIssue | undefined {
  const key = customAgentNameKey(agent.name);
  if (kept.some((a) => customAgentNameKey(a.name) === key)) {
    return issue('name-duplicate', { name: agent.name }, `two custom agents are named "${agent.name}"`);
  }
  const stem = customAgentStem(agent);
  const other = kept.find((a) => customAgentStem(a) === stem);
  if (other) {
    return issue('command-duplicate', { name: agent.name, other: other.name, stem }, `"${agent.name}" and "${other.name}" both run "${stem}"`);
  }
  return undefined;
}

/** A custom agent the loader could not keep, and why (shown in Settings). */
export interface CustomAgentDropped {
  name?: string;
  issue: CustomAgentIssue;
}

/**
 * The list from untrusted input (the file): bad entries and clashes are
 * dropped (first wins) and reported, the count is capped. Never throws. The
 * Settings save replaces the whole list, so what was dropped is shown rather
 * than lost in silence.
 */
export function normalizeCustomAgentsReport(
  input: unknown,
  opts: CustomAgentPlatform = {},
): { agents: CustomAgent[]; dropped: CustomAgentDropped[] } {
  const agents: CustomAgent[] = [];
  const dropped: CustomAgentDropped[] = [];
  if (!Array.isArray(input)) return { agents, dropped };
  for (const raw of input) {
    const n = (raw as { name?: unknown } | null)?.name;
    const name = typeof n === 'string' && n.trim() ? { name: n.trim().slice(0, CUSTOM_AGENT_NAME_MAX) } : {};
    if (agents.length >= CUSTOM_AGENTS_MAX) {
      const cap = String(CUSTOM_AGENTS_MAX);
      dropped.push({ ...name, issue: issue('agents-over-cap', { cap }, `more than ${cap} custom agents`) });
      continue;
    }
    const r = normalizeCustomAgent(raw, opts);
    if (!r.ok) {
      dropped.push({ ...name, issue: { code: r.code, params: r.params, error: r.error } });
      continue;
    }
    const clash = listClash(r.agent, agents);
    if (clash) {
      dropped.push({ name: r.agent.name, issue: clash });
      continue;
    }
    agents.push(r.agent);
  }
  return { agents, dropped };
}
