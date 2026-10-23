// Which stdin prompt, if any, a pane's bottom row shows. A closed list of
// shapes anchored at the END of the row: a row that goes on after the token
// (a log line quoting "(y/N)") is not a prompt waiting for an answer.

import { SHELL_PROMPT_QUESTION_MAX, type ShellPromptSignal } from '../../shared/shellPrompt';

// Each pattern must match up to the end of the row (trailing spaces allowed).
const YES_NO: readonly RegExp[] = [
  /[[(]\s*y\s*\/\s*n\s*[\])]\s*[?:]?\s*$/i,
  /[[(]\s*yes\s*\/\s*no\s*[\])]\s*[?:]?\s*$/i,
  // ssh: "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
  /\(\s*yes\s*\/\s*no\s*\/\s*\[fingerprint\]\s*\)\s*\??\s*$/i,
];
const ENTER: readonly RegExp[] = [
  // Trailing dots may be spaced: Windows' `pause` prints "continue . . .".
  /press\s+(?:enter|return)(?:\s+key)?(?:\s+to\s+continue)?(?:\s*[.…:!])*\s*$/i,
  /\[\s*press\s+enter\s*\]\s*$/i,
  /press\s+any\s+key(?:\s+to\s+continue)?(?:\s*[.…:!])*\s*$/i,
];
// Checked first: a secret row is never offered as anything else.
const SECRET: readonly RegExp[] = [
  /pass(?:word|phrase)\b[^\n]*:\s*$/i,
  /\bpin\b[^\n]*:\s*$/i,
  /\b(?:verification|one[- ]time|2fa|mfa|otp|authentication)\s+code\b[^\n]*:\s*$/i,
  /\botp\b[^\n]*:\s*$/i,
];

/** The bottom-most row with any content, without its trailing blanks; null when the screen is blank. */
export function lastNonBlankRow(rows: readonly string[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i].replace(/\s+$/, '');
    if (row.length > 0) return row;
  }
  return null;
}

/** The prompt `row` asks, or null when it is no prompt the daemon knows. */
export function classifyPromptRow(row: string): ShellPromptSignal | null {
  const line = row.replace(/\s+$/, '');
  if (!line) return null;
  if (SECRET.some((re) => re.test(line))) return { shape: 'secret' };
  const question = line.trim().slice(0, SHELL_PROMPT_QUESTION_MAX);
  if (YES_NO.some((re) => re.test(line))) return { shape: 'yes-no', question };
  if (ENTER.some((re) => re.test(line))) return { shape: 'enter', question };
  return null;
}
