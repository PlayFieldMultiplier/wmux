// ─── An act's text on its approval card, and the hash an approval echoes ───
//
// A comment or a new issue publishes text a bot wrote, under the owner's
// name. Its approval card shows that text whole, and the phone shows the same
// card, so the owner approves exactly what GitHub gets:
//
//   - each bot-text field is its own CommonMark fenced block at column 0,
//     info string `wmux-payload`, in a fixed order (comment: the body with
//     wmux's marker line; issue_create: the title, then the body with the
//     marker). Text read from GitHub that gives context (a target's title)
//     is fenced with the info string `text` and is not part of the payload.
//   - a fence is a backtick run longer than any backtick or tilde run in its
//     text (and at least 3), so nothing inside can close it.
//   - payloadHash is the lowercase hex sha256 of the UTF-8 bytes of the
//     payload fences' inner texts in card order, joined by one U+0000. The
//     inner text is the lines between the fence lines joined by \n, with no
//     trailing newline: exactly the stored field, which is what main posts.
//
// The text is normalised when the bot asks (\n line ends only, no trailing
// whitespace at its end) and refused when the card could show other bytes
// than the post sends: control, bidi or zero-width characters, a stored
// secret the room would redact, or a `wmux-approval` marker of its own.
// docs/phone-client-contract.md carries the same rule for the phone.

import { createHash } from 'node:crypto';

export const PAYLOAD_FENCE_INFO = 'wmux-payload';
export const CONTEXT_FENCE_INFO = 'text';

/** The hidden last line of a comment's or an issue's body: how a retry or a
 *  restart finds the post again (actExecutor.ts reconcile). */
export function actMarker(requestId: string): string {
  return `<!-- wmux-approval:${requestId} -->`;
}

/** The body as posted: the bot's text, a blank line, the marker (the
 *  marker alone for an empty body). */
export function bodyWithMarker(body: string, requestId: string): string {
  return body ? `${body}\n\n${actMarker(requestId)}` : actMarker(requestId);
}

/** \n line ends, no trailing whitespace at the end. Pure. */
export function normalizeActText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
}

/** C0/C1 controls but \n and \t, bidi controls, zero-width characters. */
// eslint-disable-next-line no-control-regex
const UNSHOWABLE =/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** Why a normalised text cannot be shown and posted as the same bytes, or
 *  null. `redact` is the room's redaction (stored secrets). Pure. */
export function actTextProblem(text: string, redact: (t: string) => string): string | null {
  if (UNSHOWABLE.test(text)) return 'it holds control, bidi or zero-width characters, which the card would not show as they are posted';
  if (/wmux-approval/i.test(text)) return 'it holds "wmux-approval", which wmux keeps for its own marker line';
  if (redact(text) !== text) return 'it holds a stored secret, which the card would hide and the post would publish';
  return null;
}

/** The fence for a text: a backtick run longer than any backtick or tilde
 *  run in it, at least 3. Pure. */
export function payloadFence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+|~+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One fenced block at column 0, as card lines. Pure. */
export function fencedLines(text: string, info: string): string[] {
  const fence = payloadFence(text);
  return [`${fence}${info}`, text, fence];
}

/** sha256 hex of the payload fields joined by U+0000. Pure. */
export function payloadHashOf(fields: readonly string[]): string {
  return createHash('sha256').update(fields.join('\u0000'), 'utf8').digest('hex');
}

/** The content key of an act (its bot text and target, no marker): one
 *  request per content while it waits. Pure. */
export function actContentKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32);
}
