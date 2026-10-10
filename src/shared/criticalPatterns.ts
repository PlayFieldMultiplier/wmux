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
  regex: RegExp;
  riskLevel: 'review' | 'critical';
  /** Human-readable name of the action. Shown in UI, used as a dedup key. */
  label: string;
}

// The rest of one PowerShell pipeline segment after a verb: it stops at `|`,
// `;`, `&&` and a newline (a backtick line continuation stays in it). Capped,
// so a long line with many verb-like words (`del` is common Spanish) costs
// linear time, not quadratic.
const PS_SEGMENT = '(?:[^|;&\\r\\n]|(?<!&)&(?!&)|`\\r?\\n){0,256}';
const PS_RECURSE = `(?=${PS_SEGMENT}\\s-r[a-z]*\\b)`;
const PS_FORCE = `(?=${PS_SEGMENT}\\s-fo[a-z]*\\b)`;

/** A PowerShell delete verb that is not part of another word (`--rm`,
 *  `git-rm`, `Remove-ItemProperty`), followed by the required flags. */
function psDelete(verb: string, flags: string): RegExp {
  return new RegExp(`(?<![\\w-])${verb}(?=\\s)${flags}`, 'i');
}

export const CRITICAL_PATTERNS: CriticalPattern[] = [
  { regex: /git\s+push\s+(?:.*--force|-f)\b/i,          riskLevel: 'critical', label: 'git push --force' },
  { regex: /git\s+reset\s+--hard\b/i,                   riskLevel: 'critical', label: 'git reset --hard' },
  { regex: /git\s+clean\s+.*-f\b/i,                     riskLevel: 'critical', label: 'git clean -f' },
  { regex: /\brm\s+(?:.*-r.*-f|-f.*-r|-rf|-fr)\s+/i,   riskLevel: 'critical', label: 'rm -rf' },
  // cmd's tree and recursive deletes (#1939): `/s` anywhere in the switches or
  // after the path (`rd /q /s x`, `rmdir x /s/q`), in any case. A `/s` glued to
  // a word (`km/s`) does not count.
  { regex: /\b(?:rmdir|rd)(?=\s)(?=[^|&\r\n]{0,256}(?:\s|\/\w)\/s\b)/i,  riskLevel: 'critical', label: 'rmdir /S' },
  { regex: /\b(?:del|erase)(?=\s)(?=[^|&\r\n]{0,256}(?:\s|\/\w)\/s\b)/i, riskLevel: 'critical', label: 'del /S' },
  // #1939 — PowerShell's tree delete. Remove-Item -Recurse deletes a whole
  // tree without asking (-Force only adds hidden and read-only files), so the
  // verb or one of its aliases plus a -Recurse, in full or abbreviated (`-r`),
  // is enough. `rm` is the exception: `rm -r` is also the Unix spelling, which
  // the `rm -rf` row above deliberately leaves alone, so `rm` also needs a
  // PowerShell -Force (`-fo`…; `-f` alone is ambiguous with -Filter and
  // PowerShell rejects it).
  { regex: psDelete('(?:Remove-Item|ri|rmdir|rd|del|erase)', PS_RECURSE), riskLevel: 'critical', label: 'Remove-Item -Recurse' },
  { regex: psDelete('rm', PS_RECURSE + PS_FORCE),                         riskLevel: 'critical', label: 'Remove-Item -Recurse' },
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
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const p of CRITICAL_PATTERNS) {
      if (p.riskLevel === 'critical' && p.regex.test(text)) return true;
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
      if (p.regex.test(text)) return true;
    }
  }
  return false;
}
