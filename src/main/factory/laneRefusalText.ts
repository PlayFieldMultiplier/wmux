// ─── A merge refusal, in the owner's words ─────────────────────────────────
//
// A merge.refused fact keeps the lane's raw reason (`predicate:reason`
// codes joined by ", ", an executor code such as `lane-paused`, or
// `repro-origin: …`): bots read it as data. The room card shows the owner
// one plain sentence per cause, never the raw code.
// The card is written here in main, so the desktop room, the Bots page and
// the phone's room view read the same text. A code this table does not know
// is shown as the code. A sentence names the PR's host ({host}): GitLab for a
// GitLab repo key, GitHub otherwise.

import { isGitlabRepoKey } from '../github/hostLane';

/** Sentences by `predicate:reason` (where a reason means different things
 *  under different predicates) and by bare reason. */
const SENTENCES: Readonly<Record<string, string>> = {
  // Merge lane predicates (moaMergeLane.ts).
  'head-moved': 'The PR\'s head moved after it was checked',
  // An approval whose bot was deleted (approvals.ts authorizeEffect).
  'bot-removed': 'The bot that asked for it was deleted',
  'checks-not-on-head': 'The checks {host} reported are not for this head',
  'checks-truncated': '{host} listed too many checks to read them all',
  'no-required-checks': 'The repository has no required checks',
  'required-check-pending': 'A required check is still running',
  'files-truncated': '{host} listed too many changed files to read them all',
  'no-files': '{host} listed no changed files',
  'not-release-pr:package-manifest': 'It changes package.json or package-lock.json',
  'dependency-patch': 'It changes dependency patches',
  'build-config': 'It changes the build configuration',
  changelog: 'It edits CHANGELOG.md',
  'ci-config': 'It changes the CI configuration',
  'release-script': 'It changes a release script',
  packaging: 'It changes packaging files',
  license: 'It changes license or notice files',
  'gate-definition-changed:package-manifest': 'It changes package.json, which defines the gate',
  'verify-script': 'It changes scripts/verify.sh, which defines the gate',
  'npm-config': 'It changes .npmrc, which the gate depends on',
  'project-config': 'It changes wmux.json, which defines the gate',
  'test-config': 'It changes the test configuration the gate runs',
  'lint-config': 'It changes the lint configuration the gate runs',
  'ts-config': 'It changes a TypeScript configuration the gate runs',
  'windows-path': 'It touches Windows-specific files, which need a check on Windows',
  'labels-truncated': '{host} listed too many labels to read them all',
  'needs-windows-verify': 'It is labelled needs-windows-verify',
  'no-author': '{host} did not report who authored it',
  'external-author': 'The author isn\'t trusted',
  'cross-repository': 'It comes from a fork',
  'no-head-branch': '{host} did not report its branch',
  'branch-not-bound': 'Its branch is not a bot task\'s branch',
  'verdicts-unreadable': 'The verdicts could not be read',
  'author-unknown': 'Who worked on it could not be determined',
  'verdict-fail': 'A verifier recorded FAIL at this head',
  'verdict-stale-head': 'The verdicts are for an older head',
  'no-verdict': 'No verifier recorded a verdict',
  'self-verified': 'Only the bot that made it verified it',
  'evidence-unreadable': 'The verify tasks\' records could not be read',
  'gate-failed': 'The verify gate failed',
  'gate-skipped': 'The verify gate was skipped, so nothing ran',
  'gate-required': 'The PASS rests on reading alone, but the base branch has a gate',
  'base-moved': 'The PASS rests on reading alone, and the base branch moved since its gate was read',
  'evidence-mismatch': 'The PASS is not backed by a matching verify task',
  'verdict-no-evidence': 'The PASS names no verify task',
  // The lane host.
  'repro-origin': 'A repro worker opened it from an issue, so you merge it',
  'tainted-origin': 'It started from outside text',
  // An "always allow" rule for another bot (approvals.ts).
  'rule-other-asker': 'Your rule covers the merges another bot asks for',
  // The lane executor (moaMergeExecutor.ts).
  'unknown-approver': 'The merge has no known approver',
  'lane-not-wired': 'The merge lane is not running',
  'lane-inputs-unreadable': 'The factory settings could not be read',
  'factory-disabled': 'The factory is off',
  'lane-paused': 'Lane auto-merge is off',
  'lane-daily-cap': 'Today\'s lane merge limit is reached',
  'identity-unknown': 'The {host} login could not be read',
  'identity-changed': 'The {host} login changed since the check',
  'pr-mismatch': '{host} answered for a different PR',
  'behind-updated': 'The branch was behind; it was updated and needs fresh checks',
  invalid: '{host} refused the merge request',
  // The act executor (actExecutor.ts): a comment, an issue, a close, a release.
  'approval-mismatch': 'The request no longer matches what was approved',
  'repo-changed': 'The repository was renamed, moved or changed since the request',
  'target-gone': 'The issue or PR is no longer on {host}',
  'target-changed': 'The issue or PR is not the one the request named',
  'already-closed': 'It was already closed',
  merged: 'The PR was merged',
  locked: 'The conversation is locked',
  'found-different': 'A post with this request\'s marker is on {host} with other text',
  'closed-by-other': 'Someone else closed it first',
  'closed-differently': 'It was closed on {host}, but not as approved',
  'secret-in-body': 'Its text holds a secret stored since the request',
  'attempts-exhausted': 'wmux tried three times and could not tell whether it went through',
  // A release (releaseAct.ts).
  'tag-taken': 'The tag already exists on {host}',
  'release-exists': 'A release with this tag is already on {host}, published or as a draft',
  'not-on-default-branch': 'The commit is no longer on the default branch',
  'default-branch-changed': 'The repository\'s default branch changed since the request',
  'checks-failing': 'A check on the commit failed',
  'checks-pending': 'A check on the commit is still running',
  'checks-not-started': 'The commit\'s checks have not started',
  'version-mismatch': 'The version in package.json or package-lock.json is not the tag\'s',
  'prerelease-mismatch': 'The tag reads as a prerelease and the request does not, or the other way round',
  'tag-not-matching-release-workflow': 'The repository\'s tag workflows do not run on this tag',
  'workflow-unreadable': 'A workflow file at the commit could not be read',
  'workflow-disabled': 'The release workflow is disabled, or GitHub Actions is off for the repository',
  'release-by-other': 'Someone else published a release with this tag',
  'published-other-target': 'A release was published, but its tag points at another commit',
};

/** Sentences for code families with a variable tail. */
const PREFIX_SENTENCES: ReadonlyArray<readonly [string, string]> = [
  ['required-check-', 'A required check did not pass'],
  ['behind-update-', 'The branch is behind and could not be updated'],
  ['blocked-', '{host} blocked the merge'],
  ['gh-', '{host} refused it'],
];

const CODE = /^[a-z0-9-]+(?::[a-z0-9-]+)?$/;

/** The owner sentence for one code on the repo `repoKey` (GitHub when
 *  absent), or null when it is not known. Pure. */
export function laneRefusalSentence(code: string, repoKey?: string): string | null {
  const cut = code.indexOf(':');
  const reason = cut >= 0 ? code.slice(cut + 1) : code;
  const own = (k: string): string | undefined => (Object.hasOwn(SENTENCES, k) ? SENTENCES[k] : undefined);
  const known = own(code) ?? own(reason) ?? PREFIX_SENTENCES.find(([p]) => reason.startsWith(p))?.[1];
  return known ? known.replace('{host}', repoKey && isGitlabRepoKey(repoKey) ? 'GitLab' : 'GitHub') : null;
}

/** The raw codes of a refusal reason, in order. A part that is `code: prose`
 *  (`repro-origin: …`) is its code; a part that is not a code is kept whole.
 *  Pure. */
export function laneRefusalCodes(reason: string): string[] {
  const whole = reason.trim();
  if (!whole) return [];
  // Prose may hold commas: only a list of bare codes is split.
  const parts = whole.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
  const list = parts.every((p) => CODE.test(p)) ? parts : [whole];
  return list.map((p) => {
    const m = /^([a-z0-9-]+(?::[a-z0-9-]+)?):\s/.exec(p);
    return m ? m[1] : p;
  });
}

/** What the owner reads for a code no sentence covers (the code itself
 *  stays in the fact, for the bots). */
export const UNKNOWN_REFUSAL_SENTENCE = 'Another merge check did not pass';

/** The card body for a refusal reason: one markdown bullet per sentence, in
 *  the owner's words only — no raw code (two predicates with the same cause
 *  share a bullet; every unknown code shares UNKNOWN_REFUSAL_SENTENCE).
 *  Empty for an empty reason. Pure. */
export function formatLaneRefusal(reason: string, repoKey?: string): string {
  return ownerSentences(reason, repoKey).map((sentence) => `- ${sentence}`).join('\n');
}

/** The distinct owner sentences of a reason, in order: a known code's
 *  sentence, UNKNOWN_REFUSAL_SENTENCE for any other code, prose (already
 *  words, not a code) on one line as it is. Pure. */
function ownerSentences(reason: string, repoKey?: string): string[] {
  const out: string[] = [];
  for (const code of laneRefusalCodes(reason)) {
    const sentence = laneRefusalSentence(code, repoKey) ?? (CODE.test(code) ? UNKNOWN_REFUSAL_SENTENCE : code.replace(/[\r\n]+/g, ' ').trim());
    if (sentence && !out.includes(sentence)) out.push(sentence);
  }
  return out;
}

/** One line in the owner's words for a refusal reason (an approval's
 *  `refusal`, a rule's skip): the sentences joined, never a raw code; text
 *  that is not a code list is kept as it is. Empty for an empty reason. Pure. */
export function laneRefusalLine(reason: string, repoKey?: string): string {
  return ownerSentences(reason, repoKey).join('; ');
}
