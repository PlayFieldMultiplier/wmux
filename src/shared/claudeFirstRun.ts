// Claude Code's one-time first-run setup (the theme picker, then sign-in and
// the security notes) is an interactive TUI flow that fires no hook. When it
// blocks Moa's brain, the chat used to show the raw terminal screen ("Dark
// mode / Light mode / ... Syntax theme: ..."), which means nothing to someone
// who never opened a terminal. This recognises that screen from the excerpt
// the brain already captures, so the chat can say what to do instead.
//
// It is not pre-completed for the user: Claude Code has no supported
// non-interactive way to finish onboarding, and choosing a theme or signing
// in on the user's behalf by editing ~/.claude.json would be guessing at a
// private file format.

const MARKERS: RegExp[] = [
  /choose the text style/i,
  /syntax theme:/i,
  /light mode \(colorblind-friendly\)|dark mode \(colorblind-friendly\)/i,
  /select login method/i,
  /claude account with subscription/i,
  /anthropic console account/i,
  /security notes:/i,
  /use claude code's terminal setup\?/i,
];

/** True when a captured terminal excerpt is Claude Code's first-run setup. */
export function isClaudeFirstRunScreen(excerpt: string | undefined | null): boolean {
  if (!excerpt) return false;
  return MARKERS.some((re) => re.test(excerpt));
}

// Claude's folder-trust question ("Do you trust the files in this folder?"),
// whose highlighted default is "No, exit". Answering it is the user's call
// (it lets Claude read, edit and run files there), so wmux never accepts it
// for them; it only explains it in plain words.
const TRUST_MARKERS: RegExp[] = [
  /do you trust the files in this folder\??/i,
  /yes,\s*i trust this folder/i,
  /claude code'?ll be able to read, edit, and execute files here/i,
];

/** True when a captured terminal excerpt is Claude Code's folder-trust prompt. */
export function isClaudeFolderTrustScreen(excerpt: string | undefined | null): boolean {
  if (!excerpt) return false;
  return TRUST_MARKERS.some((re) => re.test(excerpt));
}

export type ClaudeSetupScreen = 'first-run' | 'folder-trust';

/** Which plain-language card a refused send needs, if any. Trust wins: once
 *  the theme is picked, the trust question is what is actually on screen. */
export function claudeSetupScreen(excerpt: string | undefined | null): ClaudeSetupScreen | null {
  if (isClaudeFolderTrustScreen(excerpt)) return 'folder-trust';
  if (isClaudeFirstRunScreen(excerpt)) return 'first-run';
  return null;
}
