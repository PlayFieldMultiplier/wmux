// The factory's PR / MR lane read by the remote's host: a GitHub key goes to
// gh (GhPrReviewService), every other host to glab (GlabPrService) — the
// split PrProvider makes for the Git page (isGithubHost). Callers: the bot
// reads (roles/index.ts), pr_verdict (prVerdictHost.ts) and the merge lane's
// ports (factory/laneGh.ts).

import type { PrLaneFacts, PrReviewRead } from '../../shared/prReview';
import { isGithubHost } from './PrProvider';
import { ghPrReviewService } from './GhPrReviewService';
import { glabPrService } from './GlabPrService';

/** A repo key (`host/…`) whose host is not GitHub's, so glab serves it. */
export function isGitlabRepoKey(key: string): boolean {
  const host = key.split('/')[0] ?? '';
  return host.length > 0 && !isGithubHost(host);
}

/** The lane facts of PR (or MR iid) `n`, read fresh from the key's host. */
export function readLaneFacts(repoPath: string, key: string, n: number): Promise<PrReviewRead<PrLaneFacts>> {
  return isGitlabRepoKey(key) ? glabPrService.laneFacts(repoPath, key, n) : ghPrReviewService.laneFacts(repoPath, key, n);
}
