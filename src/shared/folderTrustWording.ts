// The questions agents ask before working in a folder they have not seen.
// A leaf module: the first-run screens (shared/agentFirstRun) and the input
// guard's trust-prompt check (daemon/approvals/approvalKeystrokes) both read
// these, and agentFirstRun already imports approvalKeystrokes.

/** The trust dialog's opening question (Claude Code 2.1.x). */
export const TRUST_HEADLINE = /is this a project you created or one you trust/i;

/** Codex's folder-trust screen (wording differs across releases; agy asks about
 *  the contents of a project). Never answered. */
export const CODEX_TRUST_HEADLINE = /do you trust the (?:contents of this (?:directory|project)|files in this folder)|trust this folder\?/i;
