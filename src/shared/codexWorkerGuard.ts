// ─── The Codex bot-worker guard's pure parts ────────────────────────────────
//
// The Codex twin of shared/botWorkerGuard.ts. A codex worker a bot started
// launches only on a line main rebuilt from an allowlist, with Codex's own
// command rules (execpolicy) refusing what the Claude worker settings refuse:
// a merge (`gh pr merge`, `gh api`), every `git push` (main pushes the task
// branch, `task.push`), the git settings that redirect a push, and the public
// `gh` acts that go to the owner as approvals. The rules are a Starlark file
// main writes into the worktree's project layer
// (`<worktree>/.codex/rules/wmux-bot-worker.rules`, CODEX_WORKER_RULES_PATH);
// main/agents/codexWorkerGuard.ts writes it, checks the folder and proves the
// rules load before the launch.
//
// Codex rules match a command's leading words (a prefix, with alternatives
// per word, no wildcards), so the rules forbid whole option families before a
// verb rather than spellings of one value, and `gh api` entirely.
//
// The launch: `-a never -s workspace-write`, network on, and the worktree's
// git folders as the only extra writable roots (so the worker can commit).
// Under `-a never` codex refuses every MCP tool call it would ask about, so
// the line pre-approves the wmux tools a worker reports through, the same list
// a Claude worker gets (FANOUT_WORKER_ALLOWED_TOOLS), one tool at a time; any
// other wmux tool stays refused (measured on codex-cli 0.162.1).
// The project `.codex/` folder stays read-only to the worker in that sandbox,
// so it cannot change the rules its session loaded, and Codex reads them once,
// when the session starts (both measured on codex-cli 0.162.1).
//
// Threat model: an intent guard against a confused or misdirected model, not
// isolation. A worker runs as the owner's user; a script, an interpreter or a
// command the rules do not match can still reach the same effects.

import { launcherStem, tokenize } from './agentResume';
import { EFFORT_TOKEN_RE } from './agentLaunchOptions';
import { FANOUT_MODEL_RE, codexTrustOverride } from './fanoutPreset';
import { ROLE_BINDING_MODEL_MAX } from './orchestratorRole';
import { stripPromptFileArgument } from './promptFileArgument';
import { FANOUT_WORKER_ALLOWED_TOOLS, splitModelEnvMarker } from './workerLaunch';

/** The rules file, relative to the worktree. */
export const CODEX_WORKER_RULES_PATH = '.codex/rules/wmux-bot-worker.rules';
/** The anchored line main adds to the repository's `info/exclude`. */
export const CODEX_WORKER_EXCLUDE_LINE = `/${CODEX_WORKER_RULES_PATH}`;
/** Every rule's justification starts with this (the model reads it). */
export const CODEX_WORKER_JUSTIFICATION_PREFIX = 'wmux bot worker:';
/** The oldest codex-cli the guard was measured on. */
export const CODEX_WORKER_MIN_VERSION = '0.162.1';

/** gh groups and the verbs that write (same intent as BOT_WORKER_PUBLIC_DENY
 *  plus the merge). */
const GH_WRITE_VERBS: Readonly<Record<string, readonly string[]>> = {
  pr: ['merge', 'comment', 'review', 'close', 'reopen', 'edit', 'lock', 'unlock'],
  issue: ['create', 'close', 'comment', 'delete', 'reopen', 'edit', 'transfer', 'lock', 'unlock', 'pin', 'unpin'],
  release: ['create', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['create', 'edit', 'delete', 'rename', 'archive', 'unarchive', 'sync'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  alias: ['set', 'import'],
};
/** gh options that take a value, spelled as their own word. */
const GH_VALUE_OPTIONS = ['-R', '--repo', '--hostname'];
/** git options before the command that take a value or change where git
 *  runs, spelled as their own word. */
const GIT_GLOBAL_OPTIONS = [
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix',
  '-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice',
];

export interface CodexWorkerRulesInput {
  /** The bot repository's key (`owner/repo` or `host/owner/repo`), when known:
   *  its one-word `--repo=<key>` spellings are refused too. */
  repoKey?: string;
  /** The worktree and its git folders: their one-word `--git-dir=` /
   *  `--work-tree=` spellings are refused too. */
  cwd: string;
  gitDirs: readonly string[];
}

/** The repository's one-word spellings for gh (`--repo=<k>`, `-R<k>`). Pure. */
function repoOptionWords(repoKey: string | undefined): string[] {
  if (!repoKey) return [];
  const parts = repoKey.split('/');
  const short = parts.length === 3 ? parts.slice(1).join('/') : repoKey;
  const host = parts.length === 3 ? parts[0] : 'github.com';
  const keys = [...new Set([short, `${host}/${short}`, `https://${host}/${short}`])];
  return keys.flatMap((k) => [`--repo=${k}`, `-R${k}`]);
}

/** The rules document. Pure. */
export function buildCodexWorkerRules(input: CodexWorkerRulesInput): string {
  const rules: { pattern: (string | string[])[]; why: string }[] = [];
  const forbid = (pattern: (string | string[])[], why: string): void => { rules.push({ pattern, why }); };
  const repoWords = repoOptionWords(input.repoKey);
  for (const [group, verbs] of Object.entries(GH_WRITE_VERBS)) {
    forbid(['gh', group, [...verbs]], group === 'pr'
      ? 'a merge goes through the merge lane, and pull request writes go to the owner as approvals'
      : `gh ${group} writes go to the owner as approvals`);
    forbid(['gh', group, [...GH_VALUE_OPTIONS, ...repoWords]], `name the gh ${group} command first, options after it`);
  }
  forbid(['gh', [...GH_VALUE_OPTIONS, ...repoWords]], 'name the gh command first, options after it');
  forbid(['gh', 'api'], 'gh api is not available; read with gh pr view / gh issue view');
  forbid(['git', 'push'], 'wmux pushes your task branch: use the task_push tool');
  forbid(['git', 'remote', ['set-url', 'add', 'rename', 'remove', 'rm']], 'the remotes are not yours to change');
  forbid(['git', 'config'], 'git config is not available to a bot worker');
  const pathWords = [`--work-tree=${input.cwd}`, ...input.gitDirs.map((d) => `--git-dir=${d}`)];
  forbid(['git', [...GIT_GLOBAL_OPTIONS, ...pathWords]], 'run git from your worktree, command first');
  const word = (t: string): string => JSON.stringify(t);
  const pattern = (p: (string | string[])[]): string => `[${p.map((t) => (Array.isArray(t) ? `[${t.map(word).join(', ')}]` : word(t))).join(', ')}]`;
  const body = rules
    .map((r) => `prefix_rule(pattern=${pattern(r.pattern)}, decision="forbidden", justification=${word(`${CODEX_WORKER_JUSTIFICATION_PREFIX} ${r.why}`)})`)
    .join('\n');
  return `# Written by wmux for a bot's fan-out worker. Rewritten before every launch.\n${body}\n`;
}

/** Does the line start codex anywhere: as a word, a path's last part, or
 *  right next to a shell operator (`codex;…`, `x&&codex`)? Over-matching is
 *  the safe side (the line is refused). Pure. */
export function namesCodex(line: string): boolean {
  return /(?:^|[\s;&|()`'"/=])codex(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s;&|()`'"<>])/i.test(line);
}

/** A path the guard writes into a shell word and a TOML string: absolute,
 *  no quote, backslash, `$`, backtick or control character. Pure. */
export function isGuardablePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  return p.startsWith('/') && !/['"`$\\\u0000-\u001f\u007f]/.test(p);
}

/** What a bot's worker on `agent` is told about its rules, one line (or ''):
 *  a codex worker, what its rules leave out. Pure. */
export function botWorkerAgentPromptNote(agent: string | undefined): string {
  return agent === 'codex'
    ? '- `gh api` and `git config` are not available to you: read a pull request or an issue with `gh pr view` / `gh issue view`, and run git and gh with the command first, options after it.\n'
    : '';
}

/** Is this a codex line (its first word launches codex)? Pure. */
export function launchesCodex(line: string | undefined): boolean {
  if (!line) return false;
  const first = tokenize(splitModelEnvMarker(line).command)[0];
  return !!first && launcherStem(first.value) === 'codex';
}

/** The parts of an accepted codex worker line. */
export interface CodexWorkerLine {
  model?: string;
  effort?: string;
  /** The operator's wmux tool level (`-c mcp_servers.wmux…`), as main wrote it. */
  wmuxTools?: string;
  /** The prompt-file argument, verbatim. */
  promptArgument: string;
}

/** `mcp_servers.wmux.enabled=false` or `mcp_servers.wmux.args=['…',…]`, the two
 *  shapes roleSurfaces.toolSurfaceShellFlags writes. */
const WMUX_TOOLS_VALUE = /^mcp_servers\.wmux\.(?:enabled=false|args=\[(?:'[^'\s"`$\\]*',)*'[^'\s"`$\\]*'\])$/;
/** The wmux tools a codex worker runs without a prompt: a Claude worker's
 *  allowed list, by the server's own tool names. */
export const CODEX_WORKER_APPROVED_TOOLS: readonly string[] = FANOUT_WORKER_ALLOWED_TOOLS.map((t) => t.replace(/^mcp__wmux__/, ''));
const POSIX_PROMPT_ARGUMENT = /^"\$\(cat '(?:[^']|'\\'')*'\)"$/;

/**
 * A codex fan-out line, checked against an ALLOWLIST: the launcher `codex`,
 * the trust override for exactly `cwd`, `-a never`, `-s workspace-write` (the
 * fan-out unattended flags), `--model`/`-m <model>`, the effort override, the
 * operator's wmux tool level, and one prompt-file argument at the end. Each
 * at most once. Anything else — another flag, a subcommand, a second shell
 * command — returns null. POSIX shells only. Pure.
 */
export function parseCodexWorkerLine(fullLine: string, cwd: string): CodexWorkerLine | null {
  if (!isGuardablePath(cwd)) return null;
  const { marker, command } = splitModelEnvMarker(fullLine);
  if (marker) return null;
  const trimmed = command.trim();
  const lastSpace = trimmed.lastIndexOf(' "$(cat ');
  if (lastSpace < 0) return null;
  const promptArgument = trimmed.slice(lastSpace + 1);
  if (!POSIX_PROMPT_ARGUMENT.test(promptArgument)) return null;
  const head = trimmed.slice(0, lastSpace);
  if (stripPromptFileArgument(head) !== head || /[;&|`\n\r<>]|\$\(/.test(head.replace(/'[^']*'/g, "''"))) return null;
  const tokens = tokenize(head);
  if (tokens.length === 0 || tokens[0].value !== 'codex' || tokens[0].quoted) return null;
  const trust = codexTrustOverride(cwd, 'darwin');
  const trustValue = trust ? trust.slice(4, -1).replace(/'\\''/g, "'") : undefined;
  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const out: Omit<CodexWorkerLine, 'promptArgument'> = {};
  for (let k = 1; k < tokens.length; k++) {
    const flag = tokens[k].value;
    const value = tokens[k + 1]?.value;
    if (tokens[k].quoted || value === undefined) return null;
    k++;
    if (flag === '-a' && value === 'never') {
      if (!once('-a')) return null;
    } else if (flag === '-s' && value === 'workspace-write') {
      if (!once('-s')) return null;
    } else if ((flag === '--model' || flag === '-m') && value.length <= ROLE_BINDING_MODEL_MAX && FANOUT_MODEL_RE.test(value)) {
      if (!once('model')) return null;
      out.model = value;
    } else if (flag === '-c' && trustValue !== undefined && value === trustValue) {
      if (!once('trust')) return null;
    } else if (flag === '-c' && value.startsWith('model_reasoning_effort=') && EFFORT_TOKEN_RE.test(value.slice('model_reasoning_effort='.length))) {
      if (!once('effort')) return null;
      out.effort = value.slice('model_reasoning_effort='.length);
    } else if (flag === '-c' && WMUX_TOOLS_VALUE.test(value)) {
      if (!once('wmux')) return null;
      out.wmuxTools = value;
    } else {
      return null;
    }
  }
  if (!seen.has('trust')) return null;
  return { ...out, promptArgument };
}

/** A POSIX single-quoted shell word. Pure. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A TOML basic string. Pure. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The line main launches: its own sandbox, approval, writable roots and
 * working root, the caller's model, effort and tool level, the worker's wmux
 * tool approvals when `opts.approveWorkerTools`, then `--` and the prompt. `writableRoots` are
 * the worktree's git folders. Returns null when a path cannot be written as
 * one shell word. Pure.
 */
export function buildCodexWorkerLaunchLine(
  parsed: CodexWorkerLine,
  cwd: string,
  writableRoots: readonly string[],
  opts: { approveWorkerTools?: boolean } = {},
): string | null {
  const trust = codexTrustOverride(cwd, 'darwin');
  if (!trust || writableRoots.length === 0 || ![cwd, ...writableRoots].every(isGuardablePath)) return null;
  const roots = `sandbox_workspace_write.writable_roots=[${writableRoots.map(tomlString).join(',')}]`;
  return [
    'codex',
    trust,
    '-a never',
    '-s workspace-write',
    `-c ${shellWord(roots)}`,
    '-c sandbox_workspace_write.network_access=true',
    ...(parsed.model ? [`--model ${parsed.model}`] : []),
    ...(parsed.effort ? [`-c model_reasoning_effort=${parsed.effort}`] : []),
    ...(parsed.wmuxTools ? [`-c ${shellWord(parsed.wmuxTools)}`] : []),
    // Only with a wmux server in the codex config: an override of a server
    // the config does not define stops codex at startup.
    ...(opts.approveWorkerTools ? CODEX_WORKER_APPROVED_TOOLS.map((t) => `-c mcp_servers.wmux.tools.${t}.approval_mode=approve`) : []),
    // Codex's working root, pinned to the folder the rules were written into.
    `-C ${shellWord(cwd)}`,
    // The prompt is never read as an option, whatever its text starts with.
    '--',
    parsed.promptArgument,
  ].join(' ');
}

/** `codex-cli 0.162.1` → [0, 162, 1], or null. Pure. */
export function parseCodexVersion(text: string): [number, number, number] | null {
  const m = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `version` at least CODEX_WORKER_MIN_VERSION? Pure. */
export function codexVersionAtLeastFloor(version: [number, number, number]): boolean {
  const floor = CODEX_WORKER_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}
