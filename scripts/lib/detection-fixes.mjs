// Pure parts of scripts/detection-fix-lead-time.mjs: read CHANGELOG.md, pick
// the agent-status detection fixes by one fixed rule, and turn GitHub dates
// into lead times.

/**
 * Releases in CHANGELOG.md, newest first: `## [X.Y.Z] — YYYY-MM-DD`, each with
 * the entries of its `### Fixed` sections (`- **Claim.** body (#N)`).
 * Entries keep their whole text with whitespace collapsed.
 */
export function parseChangelog(text) {
  const releases = [];
  for (const chunk of text.split(/^## \[/m).slice(1)) {
    const head = /^([^\]]+)\]([^\n]*)\n/.exec(chunk);
    if (!head || head[1] === 'Unreleased') continue;
    const date = /\d{4}-\d{2}-\d{2}/.exec(head[2])?.[0] ?? null;
    const fixed = [];
    for (const section of chunk.split(/^### /m).slice(1)) {
      if (section.split('\n')[0].trim() !== 'Fixed') continue;
      for (const raw of section.split('\n').slice(1).join('\n').split(/^- /m).slice(1)) {
        const text = raw.split(/\s+/).join(' ').trim();
        // Older entries have no bold claim: their first sentence stands in.
        const title = /^\*\*(.+?)\*\*/.exec(text)?.[1] ?? /^.+?[.:](\s|$)/.exec(text)?.[0].trim() ?? text;
        fixed.push({ title, text, refs: refsOf(text) });
      }
    }
    releases.push({ version: head[1], date, fixed });
  }
  return releases;
}

/** Issue / PR numbers an entry cites, in order, without repeats. */
export function refsOf(text) {
  return [...new Set([...text.matchAll(/#(\d{2,6})\b/g)].map((m) => Number(m[1])))];
}

// The rule, applied to the entry's title only (the claim, not the
// explanation): an agent state as the user reads it off the screen, in an
// agent context, minus phrases that use the same words for something else.
// "Read off the screen" is either a display word (Needs you, a dot, detected)
// or a display verb shortly before a state ("no longer shows Running",
// "reads as idle"); a bare "busy agents" or "keeps running" is not a status
// fix. Fixed on purpose: a changed rule is a new baseline.
const STATE_RE = /needs[- ]you|\b(status dots?|dots?|workspace light)\b|\bdetect(ed|ion|or)\b|\b(shows?|showing|shown|reads?|reading|reports?|reported|counts?|counting|settles?|stuck|leaves?|treats?|credits?|drops?|clears?|sees)\b[^.]{0,40}?\b(working|running|idle|busy|finished|completed?|waiting|awaiting)\b/i;
const CONTEXT_RE = /\b(agents?|claude|codex|gemini|aider|grok|kiro|opencode|copilot|agy|panes?|roster|fleet|sidebar|workspace|phone|rows?|chat)\b/i;
const NOT_STATUS_RE = /working director|long-running|status line|pull request|task status|port badge|sync badge|account|ghosted frame|cursor|accessib|its working\b/i;

export function isDetectionFix(title) {
  return STATE_RE.test(title) && CONTEXT_RE.test(title) && !NOT_STATUS_RE.test(title);
}

/** Whole days from `a` to `b` (ISO strings), or null. */
export function daysBetween(a, b) {
  if (!a || !b) return null;
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/**
 * One entry's dates from what GitHub says about its refs.
 *   reportedAt: the earliest issue it cites, or that a cited PR closes
 *   openedAt:   the earliest cited PR's creation
 *   mergedAt:   the latest merge among the PRs it cites and the PRs that
 *               closed the issues it cites (the fix landing)
 * `items` maps number → { type: 'Issue', createdAt, closedBy: [{ mergedAt }] } |
 * { type: 'PullRequest', createdAt, mergedAt, closes: [{ createdAt }] }.
 */
export function entryDates(refs, items) {
  const issues = [];
  const prs = [];
  const merges = [];
  for (const n of refs) {
    const it = items.get(n);
    if (!it) continue;
    if (it.type === 'Issue') {
      issues.push(it.createdAt);
      for (const c of it.closedBy ?? []) if (c.mergedAt) merges.push(c.mergedAt);
    } else if (it.type === 'PullRequest') {
      prs.push(it);
      if (it.mergedAt) merges.push(it.mergedAt);
      for (const c of it.closes ?? []) issues.push(c.createdAt);
    }
  }
  const min = (xs) => (xs.length ? xs.reduce((a, b) => (a < b ? a : b)) : null);
  const max = (xs) => (xs.length ? xs.reduce((a, b) => (a > b ? a : b)) : null);
  return {
    reportedAt: min(issues),
    openedAt: min(prs.map((p) => p.createdAt)),
    mergedAt: max(merges),
  };
}

/** Nearest-rank percentile of a list of numbers, or null when empty. */
export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
