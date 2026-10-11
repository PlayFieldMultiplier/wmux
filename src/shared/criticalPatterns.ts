// The daemon's ONE list of "this text describes a destructive action".
//
// It lived inside AgentDetector (main process, PTY line scanner) until the
// approval layer needed the same judgement: an approval prompt that quotes
// `rm -rf` and a PTY line that prints it are the same danger, and two lists
// would drift the moment one of them gained a pattern. Moved to `shared/` so
// the daemon build (tsconfig.daemon.json includes src/shared, not src/main)
// can reach it without pulling the Electron main tree in.
//
// Adding a pattern here changes BOTH the PTY critical-action signal and the
// approval `risk` hint. That is intended — they are the same question.

export interface CriticalPattern {
  /** A plain text rule. Each row has either this or `test`. */
  regex?: RegExp;
  /** A rule that needs more than one regex: it reads the text as commands. */
  test?: (text: string, shell: CommandShell) => boolean;
  riskLevel: 'review' | 'critical';
  /** Human-readable name of the action. Shown in UI, used as a dedup key. */
  label: string;
}

/**
 * The shell a text is written for, when the caller knows it (#1939). `any` is
 * text whose shell is unknown: a PTY line, an approval question, a Bash call.
 * It differs in one place: `rm -r` is PowerShell's Remove-Item -Recurse, but
 * also the Unix spelling, which the `rm -rf` row deliberately leaves alone.
 */
export type CommandShell = 'powershell' | 'any';

/** Whether `text` matches one row, for the shell the caller knows. */
export function matchesCriticalPattern(p: CriticalPattern, text: string, shell: CommandShell = 'any'): boolean {
  return p.test ? p.test(text, shell) : !!p.regex?.test(text);
}

// ─── Windows tree deletes (#1939) ────────────────────────────────────────────
// Read as commands, not matched as a regex: a capped lookahead missed a
// -Recurse past the cap, and an uncapped one is quadratic. One linear pass
// splits the text into simple commands (at `;`, `|`, `&`, newlines and
// brackets), keeping quoted runs whole and a backtick line continuation inside
// the command. A bracketed `( )`, `{ }` or `$( )` is a command of its own, so
// `Remove-Item (Get-ChildItem -Recurse)` is not a tree delete and
// `if (x) { ri y -r }` is.

/** PowerShell's parameter prefixes: an en dash, em dash or horizontal bar
 *  works as well as `-`. */
const PS_DASH = '[-\u2013\u2014\u2015]';
const PS_RECURSE = new RegExp(`^${PS_DASH}r[a-z]*(?::.*)?$`, 'i');
// `-f` alone is ambiguous with -Filter, and PowerShell rejects it.
const PS_FORCE = new RegExp(`^${PS_DASH}fo[a-z]*(?::.*)?$`, 'i');
const PS_DELETE_VERBS = new Set(['remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase', 'rm']);
const PS_COMMAND_FLAG = new RegExp(`^${PS_DASH}c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$`, 'i');
/** `cmd /c …` and `powershell -Command …` nest this deep before the scan gives
 *  up and calls the text critical: an unread remainder is not evidence of
 *  safety. */
const MAX_SHELL_NESTING = 4;

/** Split `text` into simple commands, each a list of words with quotes removed. */
function splitCommands(text: string): string[][] {
  const commands: string[][] = [];
  const stack: string[][] = [[]];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) stack[stack.length - 1].push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    const words = stack[stack.length - 1];
    if (words.length > 0) commands.push(words);
    stack[stack.length - 1] = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      // A quoted run stays in the current word; a backtick escapes inside "…".
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '`' ? 2 : 1;
      word += text.slice(i + 1, Math.min(j, text.length));
      inWord = true;
      i = j;
    } else if (c === '`') {
      // PowerShell's escape. Before a line break it continues the command.
      const next = text[i + 1];
      if (next === '\r' || next === '\n') {
        endWord();
        i += next === '\r' && text[i + 2] === '\n' ? 2 : 1;
      } else if (next !== undefined) {
        word += next;
        inWord = true;
        i++;
      }
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === ';' || c === '|' || c === '&' || c === '\r' || c === '\n') {
      endCommand();
    } else if (c === '(' || c === '{') {
      endWord();
      stack.push([]);
    } else if (c === ')' || c === '}') {
      endCommand();
      if (stack.length > 1) stack.pop();
    } else {
      word += c;
      inWord = true;
    }
  }
  while (stack.length > 0) {
    endCommand();
    stack.pop();
  }
  return commands;
}

/**
 * Whether any simple command in `text` satisfies `rule`. `cmd /c …`,
 * `powershell -Command …` and `pwsh -c …` are unwrapped first: their command
 * line is often one quoted word, which is read again as commands of its own.
 */
function someCommand(
  text: string,
  shell: CommandShell,
  rule: (words: string[], shell: CommandShell) => boolean,
  depth = 0,
): boolean {
  for (const words of splitCommands(text)) {
    const head = words[0].toLowerCase().replace(/\.exe$/, '');
    const inner = head === 'cmd'
      ? words.findIndex((w, i) => i > 0 && /^\/[ck]$/i.test(w))
      : head === 'powershell' || head === 'pwsh'
        ? words.findIndex((w, i) => i > 0 && PS_COMMAND_FLAG.test(w))
        : -1;
    if (inner > 0) {
      if (depth >= MAX_SHELL_NESTING) return true;
      const innerShell: CommandShell = head === 'cmd' ? 'any' : 'powershell';
      if (someCommand(words.slice(inner + 1).join(' '), innerShell, rule, depth + 1)) return true;
    } else if (rule(words, shell)) {
      return true;
    }
  }
  return false;
}

/** cmd's `/s` on one of `verbs`, anywhere after it in the command (`if exist x
 *  rd /s /q x`), glued to it (`rd/s/q`) or to another switch (`/q/s`). A `/s`
 *  inside a word (`km/s`) is not a switch. */
function cmdRecursiveDelete(verbs: ReadonlySet<string>): (words: string[]) => boolean {
  return (words) => {
    const at = words.findIndex((w) => verbs.has(w.split('/')[0].toLowerCase()));
    if (at === -1) return false;
    const glued = words[at].slice(words[at].split('/')[0].length);
    return [glued, ...words.slice(at + 1)].some(
      (w) => w.startsWith('/') && w.split('/').some((sw) => sw.toLowerCase() === 's'),
    );
  };
}

/**
 * PowerShell's tree delete: Remove-Item or one of its aliases, in command
 * position (so `Uso del comando: grep -r` is prose), with a -Recurse in full or
 * abbreviated. -Recurse alone deletes the tree without asking; -Force only adds
 * hidden and read-only files. `rm` in text of unknown shell also needs a
 * -Force: there `rm -r` may be the Unix spelling.
 */
function psTreeDelete(words: string[], shell: CommandShell): boolean {
  const verb = words[0].replace(/^.*\\/, '').toLowerCase();
  if (!PS_DELETE_VERBS.has(verb)) return false;
  const args = words.slice(1);
  if (!args.some((w) => PS_RECURSE.test(w))) return false;
  return verb !== 'rm' || shell === 'powershell' || args.some((w) => PS_FORCE.test(w));
}

const RD_VERBS: ReadonlySet<string> = new Set(['rmdir', 'rd']);
const DEL_VERBS: ReadonlySet<string> = new Set(['del', 'erase']);

export const CRITICAL_PATTERNS: CriticalPattern[] = [
  { regex: /git\s+push\s+(?:.*--force|-f)\b/i,          riskLevel: 'critical', label: 'git push --force' },
  { regex: /git\s+reset\s+--hard\b/i,                   riskLevel: 'critical', label: 'git reset --hard' },
  { regex: /git\s+clean\s+.*-f\b/i,                     riskLevel: 'critical', label: 'git clean -f' },
  { regex: /\brm\s+(?:.*-r.*-f|-f.*-r|-rf|-fr)\s+/i,   riskLevel: 'critical', label: 'rm -rf' },
  { test: (t, sh) => someCommand(t, sh, cmdRecursiveDelete(RD_VERBS)),  riskLevel: 'critical', label: 'rmdir /S' },
  { test: (t, sh) => someCommand(t, sh, cmdRecursiveDelete(DEL_VERBS)), riskLevel: 'critical', label: 'del /S' },
  { test: (t, sh) => someCommand(t, sh, psTreeDelete),                  riskLevel: 'critical', label: 'Remove-Item -Recurse' },
  { regex: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,     riskLevel: 'critical', label: 'DROP TABLE/DATABASE' },
  { regex: /\bDELETE\s+FROM\b/i,                        riskLevel: 'review',   label: 'DELETE FROM' },
  { regex: /\bTRUNCATE\s+TABLE\b/i,                     riskLevel: 'critical', label: 'TRUNCATE TABLE' },
  { regex: /\bnpm\s+publish\b/i,                        riskLevel: 'critical', label: 'npm publish' },
  { regex: /\bterraform\s+destroy\b/i,                  riskLevel: 'critical', label: 'terraform destroy' },
  { regex: /\bkubectl\s+delete\b/i,                     riskLevel: 'review',   label: 'kubectl delete' },
];

/**
 * Whether any piece of the supplied text names a `critical`-level action.
 *
 * `review`-level patterns deliberately do NOT count: this answers a yes/no
 * question ("is this the dangerous class?") for callers that have one flag to
 * set, and widening it to the softer tier would make the flag mean "something
 * matched", which is not a thing a UI can act on.
 *
 * Every regex here is anchorless and case-insensitive by construction, so the
 * caller passes whatever text it has — a PTY line, a question, an option label.
 * None of them carry the `g` flag, so there is no `lastIndex` to reset between
 * calls.
 */
export function hasCriticalRisk(...texts: (string | undefined | null)[]): boolean {
  return hasCriticalRiskIn('any', ...texts);
}

/** `hasCriticalRisk` for text the caller knows is written for `shell` — a
 *  PowerShell tool call's input (#1939). */
export function hasCriticalRiskIn(shell: CommandShell, ...texts: (string | undefined | null)[]): boolean {
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const p of CRITICAL_PATTERNS) {
      if (p.riskLevel === 'critical' && matchesCriticalPattern(p, text, shell)) return true;
    }
  }
  return false;
}

/**
 * Whether any piece of the supplied text names an action at EITHER tier.
 *
 * The counterpart to `hasCriticalRisk`, for the one caller whose question is
 * not "is this the dangerous class?" but "may this be approved with one tap on
 * a locked screen?".
 *
 * Those are different questions and the softer tier answers them differently.
 * `DELETE FROM` and `kubectl delete` are `review` precisely because they are
 * destructive-but-recoverable — worth a second look, not worth a red banner. A
 * second look is exactly what a locked phone cannot give: there is no screen to
 * read, no Face ID, and no undo behind the button. So for that decision the
 * softer tier belongs on the same side as the harder one.
 *
 * See `buildApprovalPushPayload`, the only caller. Do not reach for this to set
 * `ApprovalRequest.risk` — that field means `critical` and nothing else, and
 * widening it would relabel every `DELETE FROM` in the UI.
 */
export function hasElevatedRisk(...texts: (string | undefined | null)[]): boolean {
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const p of CRITICAL_PATTERNS) {
      if (matchesCriticalPattern(p, text)) return true;
    }
  }
  return false;
}
