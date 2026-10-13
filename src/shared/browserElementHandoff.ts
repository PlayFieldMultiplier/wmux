import { sanitizeRemoteText } from './a2aRemoteDelivery';

/**
 * Browser inspector → agent hand-off. The user picks an element in a browser
 * tab, adds an optional note, and the pair is typed into the input line of the
 * terminal in the same pane (no Enter — the user sends it).
 *
 * Everything about the element comes from the page, which is untrusted: it is
 * validated here, stripped of terminal control sequences, collapsed to ONE
 * line (a newline typed into a shell without bracketed paste runs the line),
 * and length-capped.
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
  const clean = sanitizeRemoteText(raw).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
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

/** The single line typed into the terminal: the note first, then the element. */
export function formatElementHandoff(el: InspectedElement, note: string): string {
  const where = [el.title, el.url].filter(Boolean).join(' — ');
  const parts = [`[browser element]${where ? ` ${where}` : ''}`, `selector: ${el.selector}`];
  if (el.tag) parts.push(el.tag);
  if (el.text) parts.push(`text: "${el.text}"`);
  const element = parts.join(' · ');
  const n = oneLine(note, HANDOFF_NOTE_MAX);
  return n ? `${n} (${element})` : element;
}
