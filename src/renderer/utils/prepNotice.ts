// The toast text for a new worktree whose preparation did not run.
export function prepSkipKey(reason: string | undefined): 'git.prepMalformed' | 'git.prepNeedsReview' | 'git.prepSkipped' {
  if (reason === 'malformed') return 'git.prepMalformed';
  if (reason === 'needs-review') return 'git.prepNeedsReview';
  return 'git.prepSkipped';
}
