// Quiet recovery reads a parsed viewport, not a byte stream. Every predicate
// requires interactive choices at the bottom; a quoted question alone is not
// evidence that the agent is currently asking for permission.
import { parseTerminalPrompt } from '../../daemon/approvals/terminalPromptParse';

export interface ScreenApproval {
  text: string;
  message: string;
}

function rowsAtBottom(rows: readonly string[]): string[] {
  return rows.map((row) => row.replace(/[│║┃╭╮╯╰┌┐┘└]/g, ' ').trim()).filter(Boolean).slice(-24);
}

export function claudeScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const prompt = parseTerminalPrompt(rows);
  return prompt?.active ? { text: prompt.question.replace(/\s+/g, ''), message: 'Approval requested' } : null;
}

function choiceDialog(rows: readonly string[], question: RegExp, footer: RegExp): string | null {
  const tail = rowsAtBottom(rows);
  if (!footer.test(tail.at(-1) ?? '')) return null;
  const q = tail.findIndex((row) => question.test(row));
  if (q < 0) return null;
  const body = tail.slice(q + 1, -1);
  const option = /^[❯›>]?\s*(?:\d+[.)]\s*)?(?:Yes|No)\b/i;
  const choices = body.filter((row) => option.test(row));
  if (choices.length < 2 || choices.filter((row) => /^[❯›>]/.test(row)).length !== 1) return null;
  if (!choices.some((row) => /\bYes\b/i.test(row)) || !choices.some((row) => /\bNo\b/i.test(row))) return null;
  // A command body may precede the choices. Nothing except choices may
  // follow the first one; subsequent agent output means this is old text.
  const first = body.findIndex((row) => option.test(row));
  if (!body.slice(first).every((row) => option.test(row))) return null;
  return tail[q] ?? null;
}

export function agyScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(rows, /^Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+project\?$/,
    /^(?:↑\/↓|↑↓)\s+Navigate\s*[·•]\s*enter\s+Confirm$/i);
  return text ? { text, message: 'Project trust prompt' } : null;
}

/** Codex 0.157.1 command/edit fixtures: numbered choices and a final key hint. */
export function codexScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(rows, /^Would you like to (?:run the following command|make the following edits)\?$/,
    /^Press enter to confirm or esc to cancel$/i);
  return text ? { text, message: 'Approval requested' } : null;
}

/** OpenCode 1.18.30 permission fixture: horizontal choices with a key footer. */
export function openCodeScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const tail = rowsAtBottom(rows).slice(-12);
  const footer = /^Allow once\s+Allow always\s+Reject\s+ctrl\+f fullscreen\s+⇆ select\s+enter confirm$/i;
  if (!footer.test(tail.at(-1) ?? '') || !tail.includes('△ Permission required')) return null;
  return { text: '△ Permission required', message: 'Permission requested' };
}
