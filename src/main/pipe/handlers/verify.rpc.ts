// ─── verify.recordVerdict — a verifier's PASS/FAIL on one PR head ────────────
//
// The method behind the pr_verdict MCP tool (shared/prVerdict.ts has the
// contract). Identity is server-resolved exactly as for moa.ask
// (resolvePaneCaller): the verified senderPtyId's workspace, never params; a
// brain, a hosted workspace or an unattributed caller is refused. The repo is
// the one the verifier pane's own cwd belongs to. Before recording:
//   - the PR head is read fresh (the merge lane's read) and must be `headSha`;
//   - `git rev-parse HEAD` in the verifier's cwd must be `headSha`;
//   - the verifier's cwd must not be on the PR's own branch (a detached
//     checkout of the head is the expected shape).
// Independent of Moa's delegate: a verdict is recorded whether or not it is on.

import type { RpcRouter } from '../RpcRouter';
import {
  PR_VERDICT_RPC,
  parsePrVerdictInput,
  type PrVerdictRecord,
  type PrVerdictResult,
} from '../../../shared/prVerdict';
import type { PrLaneFacts } from '../../../shared/prReview';
import { bodyOf, resolvePaneCaller, type MoaRpcDeps } from './moa.rpc';

export interface VerifyRpcDeps extends Pick<MoaRpcDeps, 'resolvePtyWorkspace' | 'paneCwd'> {
  /** The remote key of the repo a cwd belongs to, or null. */
  repoKeyOf: (cwd: string) => Promise<string | null>;
  /** The PR read fresh (LANE_PR_QUERY); throws when it cannot be read. */
  readPr: (repoPath: string, repoKey: string, prNumber: number) => Promise<PrLaneFacts>;
  /** `git <args>` in `cwd`, trimmed stdout; null when git fails. */
  git: (args: string[], cwd: string) => Promise<string | null>;
  record: (rec: PrVerdictRecord) => Promise<void>;
  now?: () => number;
}

export function registerVerifyRpc(router: RpcRouter, deps: VerifyRpcDeps): void {
  router.register(PR_VERDICT_RPC, async (params, ctx): Promise<PrVerdictResult> => {
    const who = await resolvePaneCaller(deps, params, ctx);
    if (!who) return { ok: false, code: 'not-attributed', message: 'wmux could not tie this call to your pane' };
    const parsed = parsePrVerdictInput(bodyOf(params));
    if (!parsed.ok) return { ok: false, code: 'invalid', message: `${parsed.field ? `${parsed.field}: ` : ''}${parsed.message}` };
    const input = parsed.value;
    const cwd = who.cwd;
    const repoKey = cwd ? await deps.repoKeyOf(cwd).catch(() => null) : null;
    if (!repoKey) return { ok: false, code: 'no-repo', message: 'your working directory is not in a GitHub repository wmux can read' };
    let facts: PrLaneFacts;
    try {
      facts = await deps.readPr(cwd, repoKey, input.prNumber);
    } catch {
      return { ok: false, code: 'pr-read-failed', message: 'the pull request could not be read' };
    }
    if (facts.number !== input.prNumber) return { ok: false, code: 'pr-read-failed', message: 'GitHub answered for another pull request' };
    if (facts.headRefOid !== input.headSha) return { ok: false, code: 'head-mismatch', message: 'the pull request has another head than headSha; verify the current head' };
    const checkedOut = await deps.git(['rev-parse', 'HEAD'], cwd);
    if (checkedOut !== input.headSha) return { ok: false, code: 'checkout-mismatch', message: 'your working directory does not have headSha checked out' };
    const branch = await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (branch === null) return { ok: false, code: 'checkout-mismatch', message: 'the branch of your working directory could not be read' };
    if (facts.headRefName && branch === facts.headRefName) {
      return { ok: false, code: 'on-pr-branch', message: 'verify from a separate checkout of headSha (detached), not the PR branch' };
    }
    const record: PrVerdictRecord = {
      version: 1,
      repoKey,
      prNumber: input.prNumber,
      headSha: input.headSha,
      verdict: input.verdict,
      principal: { workspaceId: who.asker.workspaceId, ptyId: who.asker.ptyId, agent: who.asker.agent },
      summary: input.summary,
      at: (deps.now ?? Date.now)(),
    };
    try {
      await deps.record(record);
    } catch {
      return { ok: false, code: 'store-error', message: 'the verdict could not be saved' };
    }
    return { ok: true, record };
  });
}
