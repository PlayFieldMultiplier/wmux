import { sanitizeRemoteText } from './a2aRemoteDelivery';

/**
 * Browser inspector → agent hand-off. The user picks an element in a browser
 * tab, adds an optional note, and the pair is typed into the input line of the
 * terminal in the same pane (no Enter — the user sends it).
 *
 * Everything about the element comes from the page, which is untrusted: it is
 * validated here, stripped of terminal control sequences, collapsed to ONE
 * line (a newline typed into a shell without bracketed paste runs the line),
 * and length-capped. The line only ever goes to a terminal running an agent
 * (the caller checks): it is a prompt, never a shell command.
 */
export interface InspectedElement {
  title: string;
  url: string;
  selector: string;
  /** The element's opening tag with a few identifying attributes. */
  tag: string;
  /** The start of the element's visible text. */
  text: string;
}

const FIELD_MAX = { title: 120, url: 300, selector: 200, tag: 240, text: 200 } as const;
export const HANDOFF_NOTE_MAX = 1000;

function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Counted in code points, so a cut never splits a surrogate pair.
  const chars = Array.from(sanitizeRemoteText(raw).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** The inspector's result as the page reported it, or null when it is not one. */
export function parseInspectedElement(raw: unknown): InspectedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const selector = oneLine(r.selector, FIELD_MAX.selector);
  if (!selector) return null;
  return {
    title: oneLine(r.title, FIELD_MAX.title),
    url: oneLine(r.url, FIELD_MAX.url),
    selector,
    tag: oneLine(r.tag, FIELD_MAX.tag),
    text: oneLine(r.text, FIELD_MAX.text),
  };
}

/**
 * The single line typed into the terminal: the user's note, then the element
 * as a JSON object. Every page-supplied field is a JSON string, so a page
 * cannot close a quote and append words that read as the user's instruction.
 */
export function formatElementHandoff(el: InspectedElement, note: string): string {
  const fields: Record<string, string> = { page: el.title, url: el.url, selector: el.selector, tag: el.tag, text: el.text };
  const element = JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, v]) => v)));
  const n = oneLine(note, HANDOFF_NOTE_MAX);
  return `${n ? `${n} ` : ''}[browser element] ${element}`;
}
