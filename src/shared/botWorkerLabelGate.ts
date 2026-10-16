// ─── A bot worker may label a pull request, and edit nothing else on it ────
//
// The worker rules (botWorkerGuard.ts) refuse `gh pr edit` whole. A worker
// may still add or remove labels: `gh pr edit <number> --add-label <labels>`
// and/or `--remove-label <labels>`, alone on the line. Claude Code's pattern
// rules cannot say that — a deny always beats an allow, whatever their order,
// and a `*` has no "but not": dropping the blanket deny leaves every flag the
// rules do not name (an unknown one, a future one) free. So a strict launch's
// `--settings` (botWorkerMcp.ts buildWorkerSettings) carries, instead of the
// blanket `gh pr edit` deny:
//
//  - a PreToolUse hook on Bash that runs this module's script. It reads the
//    command Claude Code is about to run and refuses (exit 2) any line that
//    holds a `gh pr edit` — after `;`, `&&`, `|`, inside `$(...)`, quoted or
//    escaped (`gh pr "edit"`) — unless the whole line is exactly the label
//    form. It never allows anything: a line it passes still meets every deny
//    rule. The hook line exits 2 when the script cannot run (`|| exit 2`),
//    so a missing node or script refuses every command rather than none.
//  - deny rules for every other `gh pr edit` flag gh has (FLAG_DENY), which
//    hold even where hooks are off (a user's `disableAllHooks: true`);
//  - allow rules for the label form (LABEL_ALLOW), so a worker that does not
//    run under bypass is not asked about it. The hook refuses before any
//    allow is read, so `--add-label x --title y`, which the allow pattern
//    matches, is still refused.
//
// A WSL pane's worker (the legacy plan) keeps the blanket deny: its hooks
// run in Linux, where this script's node is not known to exist.
//
// Threat model as botWorkerGuard.ts: an intent guard against a confused or
// misdirected model, not isolation.

import { ghSubcommandDeny, isQuotable } from './botWorkerGuard';

/** The blanket rules the gate replaces. */
export const BOT_WORKER_PR_EDIT_DENY: readonly string[] = ghSubcommandDeny('pr', 'edit');

/** Every `gh pr edit` flag but the two label flags, refused by pattern in
 *  any spelling gh reads (`--title x`, `--title=x`, `-tx`), after gh's
 *  global options too. */
export const BOT_WORKER_PR_EDIT_FLAG_DENY: readonly string[] = [
  '--title', '--body', '--base', '--milestone', '--remove-milestone', '--repo',
  '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project', '--remove-project',
  '-t', '-b', '-F', '-B', '-m', '-R',
].map((flag) => `Bash(gh*pr*edit* ${flag}*)`);

/** The label form, so a worker outside bypass is not asked about it. */
export const BOT_WORKER_LABEL_ALLOW: readonly string[] = ['add', 'remove'].flatMap((v) => [
  `Bash(gh pr edit * --${v}-label *)`,
  `Bash(gh pr edit * --${v}-label=*)`,
]);

/**
 * The gate, a CommonJS script for node: stdin is Claude Code's PreToolUse
 * input, exit 0 lets the command on to the rules, exit 2 refuses it with
 * the message on stderr.
 *
 *  - DETECT: `gh` (or `gh.exe`, after a path), gh's global options, `pr`,
 *    options again, `edit` — anywhere on the line, read as written and with
 *    quotes and backslashes taken out.
 *  - ALLOWED: the whole line is `gh pr edit <number>` and one or more
 *    `--add-label`/`--remove-label` with a value (`=` or a space) of label
 *    characters, bare or in one pair of quotes (a space allowed inside).
 *    Nothing in it is a shell operator, an expansion or a redirection.
 */
export const BOT_WORKER_LABEL_GATE_SCRIPT = String.raw`'use strict';
// wmux: a bot worker's gh pr edit gate (src/shared/botWorkerLabelGate.ts).
const DETECT = /(^|[^A-Za-z0-9_.-])gh(\.exe)?(\s+-\S+(\s+[^\s-]\S*)?)*\s+pr(\s+-\S+(\s+[^\s-]\S*)?)*\s+edit(\s|$)/;
const STRIP = /["'\\\x60]/g;
const VALUE = '(?:[A-Za-z0-9][A-Za-z0-9._:/,+-]*|"[A-Za-z0-9][A-Za-z0-9._:/ ,+-]*"|\'[A-Za-z0-9][A-Za-z0-9._:/ ,+-]*\')';
const ALLOWED = new RegExp('^[ \\t]*gh[ \\t]+pr[ \\t]+edit[ \\t]+[1-9][0-9]{0,9}(?:[ \\t]+--(?:add|remove)-label(?:=|[ \\t]+)' + VALUE + ')+[ \\t]*$');
function refuse(why) {
  process.stderr.write('wmux: ' + why + '\n');
  process.exit(2);
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('error', () => refuse('the gh pr edit gate could not read the command'));
process.stdin.on('end', () => {
  let command;
  try {
    command = JSON.parse(raw).tool_input.command;
  } catch (e) {
    refuse('the gh pr edit gate could not read the command');
  }
  if (typeof command !== 'string') refuse('the gh pr edit gate could not read the command');
  if (!DETECT.test(command) && !DETECT.test(command.replace(STRIP, ''))) process.exit(0);
  if (ALLOWED.test(command)) process.exit(0);
  refuse('a bot worker runs gh pr edit only to label: gh pr edit <number> --add-label <labels> and/or --remove-label <labels>, alone on the line (no other flag, no ; && | $( ) or redirection). Anything else on a pull request goes to the owner. A message that mentions gh pr edit goes in a file (git commit -F, gh pr create --body-file).');
});
`;

/** The hook line: the script, refusing when it cannot run. */
export function labelGateHookCommand(scriptFile: string): string {
  return `node "${scriptFile}" || exit 2`;
}

/** The worker rules with the gate in place of the blanket `gh pr edit`
 *  deny, or null when the script's path cannot sit in a hook line (the
 *  caller then keeps the blanket deny). Pure. */
export function labelGateRules(deny: readonly string[], scriptFile: string): {
  deny: string[];
  allow: string[];
  hook: { matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> };
} | null {
  if (!isQuotable(scriptFile)) return null;
  return {
    deny: [...deny.filter((r) => !BOT_WORKER_PR_EDIT_DENY.includes(r)), ...BOT_WORKER_PR_EDIT_FLAG_DENY],
    allow: [...BOT_WORKER_LABEL_ALLOW],
    hook: { matcher: 'Bash', hooks: [{ type: 'command', command: labelGateHookCommand(scriptFile), timeout: 10 }] },
  };
}
