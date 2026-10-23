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

/**
 * Where one change sits in the daemon's order. `seq` grows on every set and
 * clear of any pane; `epoch` names the daemon process, so a restarted daemon,
 * whose `seq` starts again, still reads as newer.
 */
export interface ShellPromptVersion {
  epoch: string;
  seq: number;
}

/** One pane's prompt changing: the `shell.prompt` event's data. */
export interface ShellPromptChange extends ShellPromptVersion {
  /** Null clears. */
  prompt: ShellPromptSignal | null;
}

/** Every prompt shown, as of `seq`: the `daemon.shellPrompt.list` answer. */
export interface ShellPromptList extends ShellPromptVersion {
  prompts: Array<{ sessionId: string; prompt: ShellPromptSignal; seq: number }>;
}

function parseVersion(r: Record<string, unknown>): ShellPromptVersion | null {
  if (typeof r.epoch !== 'string' || !r.epoch) return null;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 0) return null;
  return { epoch: r.epoch, seq: r.seq };
}

/** A received change, checked: null when its version is malformed (an unordered change cannot be placed). */
export function parseShellPromptChange(raw: unknown): ShellPromptChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = parseVersion(r);
  return version ? { ...version, prompt: parseShellPromptSignal(r.prompt) } : null;
}

/** A received list, checked: null when malformed; an entry that is malformed is dropped. */
export function parseShellPromptList(raw: unknown): ShellPromptList | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = parseVersion(r);
  if (!version || !Array.isArray(r.prompts)) return null;
  const prompts: ShellPromptList['prompts'] = [];
  for (const item of r.prompts as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    const prompt = parseShellPromptSignal(i.prompt);
    if (typeof i.sessionId !== 'string' || !i.sessionId || !prompt) continue;
    if (typeof i.seq !== 'number' || !Number.isSafeInteger(i.seq) || i.seq < 0 || i.seq > version.seq) continue;
    prompts.push({ sessionId: i.sessionId, prompt, seq: i.seq });
  }
  return { ...version, prompts };
}
