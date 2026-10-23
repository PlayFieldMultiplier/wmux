// A pane with no agent whose foreground command waits on stdin: `git push`'s
// `(y/N)`, "Press Enter to continue", ssh's host-key question, a password.
// The daemon finds it (daemon/shellPrompt/), main relays it on the pane's
// metadata, and the renderer shows it as Needs you. Informational only: nothing
// answers it from here.

/**
 * What the prompt asks for:
 * - `yes-no` — a y/N, yes/no or ssh host-key question;
 * - `enter` — "Press Enter to continue" and the like;
 * - `secret` — a password, passphrase, PIN or code. It is never answered
 *   remotely, and its row is never carried anywhere.
 */
export type ShellPromptShape = 'yes-no' | 'enter' | 'secret';

/** The pane's stdin prompt as the daemon reports it. */
export interface ShellPromptSignal {
  shape: ShellPromptShape;
  /** The prompt row, cleaned and capped. Absent on `secret`: a password row never leaves the daemon. */
  question?: string;
}

/** Longest `question` carried. */
export const SHELL_PROMPT_QUESTION_MAX = 200;

const SHAPES: readonly ShellPromptShape[] = ['yes-no', 'enter', 'secret'];

/**
 * A received signal, checked: null for anything malformed. A `secret` keeps no
 * question even when one came, so a bad sender cannot route a password row
 * through it.
 */
export function parseShellPromptSignal(raw: unknown): ShellPromptSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.shape !== 'string' || !SHAPES.includes(r.shape as ShellPromptShape)) return null;
  const shape = r.shape as ShellPromptShape;
  if (shape === 'secret') return { shape };
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const question = typeof r.question === 'string' ? r.question.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, SHELL_PROMPT_QUESTION_MAX) : '';
  return question ? { shape, question } : { shape };
}
