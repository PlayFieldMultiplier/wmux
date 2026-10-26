// Quiet recovery reads a parsed viewport, not a byte stream. Every predicate
// requires interactive choices at the bottom; a quoted question alone is not
// evidence that the agent is currently asking for permission.
import { parseTerminalPrompt } from '../../daemon/approvals/terminalPromptParse';

export interface ScreenApproval {
  text: string;
  message: string;
}

function rowsAtBottom(rows: readonly string[]): string[] {
  return rows.map((row) => row.replace(/[│║┃╭╮╯╰┌┐┘└]/g, ' ').trim()).filter(Boolean);
}

export function claudeScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const prompt = parseTerminalPrompt(rows);
  return prompt?.active ? { text: prompt.question.replace(/\s+/g, ''), message: 'Approval requested' } : null;
}

/** A dialog's choice rows: `option` is one choice, `selected` marks exactly
 *  one of them, and every `required` choice must be offered. */
interface ChoiceRows {
  option: RegExp;
  selected: RegExp;
  required: readonly RegExp[];
}

const YES_NO_CHOICES: ChoiceRows = {
  option: /^[❯›>]?\s*(?:\d+[.)]\s*)?(?:Yes|No)\b/i,
  selected: /^[❯›>]/,
  required: [/\bYes\b/i, /\bNo\b/i],
};

function choiceDialog(rows: readonly string[], question: RegExp, footer: RegExp, choice: ChoiceRows = YES_NO_CHOICES): string | null {
  const tail = rowsAtBottom(rows);
  if (!footer.test(tail.at(-1) ?? '')) return null;
  let q = -1;
  for (let i = tail.length - 2; i >= 0; i--) {
    if (question.test(tail[i] ?? '')) { q = i; break; }
  }
  if (q < 0) return null;
  const body = tail.slice(q + 1, -1);
  const { option, selected, required } = choice;
  const choices = body.filter((row) => option.test(row));
  if (choices.length < 2 || choices.filter((row) => selected.test(row)).length !== 1) return null;
  if (!required.every((needed) => choices.some((row) => needed.test(row)))) return null;
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

/** What a Pi choice row starts with once piSelectorRows has read its indent. */
const PI_CHOICE = '◦';
const PI_TRUST_CHOICES: ChoiceRows = {
  option: new RegExp(`^[→${PI_CHOICE}] (?:Trust|Do not trust)\\b`),
  selected: /^→/,
  required: [new RegExp(`^[→${PI_CHOICE}] Trust\\b`), new RegExp(`^[→${PI_CHOICE}] Do not trust\\b`)],
};

/**
 * Pi's selector rows as choiceDialog reads them. Pi 1.4.0 indents a choice by
 * three cells (` → ` on the selected one) and its key footer by one, and in a
 * narrow pane wraps either onto rows indented by one (44-column capture): those
 * rows are joined back onto the choice or footer above. A choice is known by
 * its indent, which the trim in choiceDialog would lose, so an unselected one
 * is marked with PI_CHOICE: a wrapped path row reading `Trust-repo/…` is no
 * choice. Frame rules are dropped.
 */
function piSelectorRows(rows: readonly string[]): string[] {
  const out: string[] = [];
  let joinable = false;
  for (const row of rows) {
    if (!row.trim() || /^\s*─+\s*$/.test(row)) { joinable = false; continue; }
    if (joinable && /^ [^\s→]/.test(row) && !row.startsWith(' ↑↓ ')) {
      out[out.length - 1] += ` ${row.trim()}`;
      continue;
    }
    const unselected = /^ {3}\S/.test(row);
    out.push(unselected ? `${PI_CHOICE} ${row.trim()}` : row);
    joinable = unselected || /^ (?:→ |↑↓ )/.test(row);
  }
  return out;
}

/** Pi 1.4.0 project-trust selector (live capture): one `→` choice, then a key footer. */
export function piScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(piSelectorRows(rows), /^Trust project folder\?$/,
    /^↑↓ navigate\s+enter select\s+escape\/ctrl\+c cancel$/, PI_TRUST_CHOICES);
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
