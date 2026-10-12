// pr_verdict — the MCP tool (shared/prVerdict.ts has the contract).
//
// Registered beside moa_ask (src/mcp/moaAsk.ts): only when the owner turned
// the ask mode on, only in the `full` profile, appended after moa_ask_status,
// so the default tools/list the probe pins stays byte-identical. Main
// re-validates every input with parsePrVerdictInput; this schema is the
// caller-facing description, not the check.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PR_VERDICT_SUMMARY_MAX, PR_VERDICT_TOOL } from '../shared/prVerdict';

export const PR_VERDICT_DESCRIPTION =
  'Record your verification verdict on a PR head you did not write. Check out headSha (detached, not the PR branch) in your cwd, verify, then call this; ' +
  'pass only if every check passed. Order: verify → pr_verdict → then moa_ask for the merge (a verdict after the merge question is not re-read for it).';

export const PR_VERDICT_INPUT_SHAPE = {
  prNumber: z.number().int(),
  headSha: z.string().describe('Full head SHA you verified'),
  verdict: z.enum(['pass', 'fail']),
  summary: z.string().max(PR_VERDICT_SUMMARY_MAX).describe('What you checked'),
} as const;

/** The pipe call budget: main reads the PR from GitHub before recording. */
const PR_VERDICT_TIMEOUT_MS = 30_000;

export interface PrVerdictToolDeps {
  callRpc: (method: 'verify.recordVerdict', params: Record<string, unknown>, timeoutMs?: number) => Promise<{ content: { type: 'text'; text: string }[] }>;
  /** The caller's VERIFIED pane (PID-walk hit only, never the env hint);
   *  '' when unknown, which main answers `not-attributed`. */
  getSenderPtyId: () => Promise<string>;
}

export function registerPrVerdictTool(server: Pick<McpServer, 'tool'>, deps: PrVerdictToolDeps): void {
  server.tool(PR_VERDICT_TOOL, PR_VERDICT_DESCRIPTION, PR_VERDICT_INPUT_SHAPE, async (input) => {
    const senderPtyId = await deps.getSenderPtyId().catch(() => '');
    return deps.callRpc('verify.recordVerdict', senderPtyId ? { ...input, senderPtyId } : { ...input }, PR_VERDICT_TIMEOUT_MS);
  });
}
