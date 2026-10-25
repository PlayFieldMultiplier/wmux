// approval_request / approval_list — a bot asks the owner for an
// irreversible or public act and reads its own requests
// (shared/botApproval.ts), registered with registerToolModule
// (src/mcp/toolModules.ts). Every call carries the bot's token; main takes
// the bot, its repository, the PR head, the gh login and the thread from its
// own state, so no tool sends them, and no tool decides a request.

import { z } from 'zod';
import { BOT_APPROVAL_RPC, BOT_REQUESTABLE_ACTIONS, type ApprovalAction, type ApprovalState } from '../shared/botApproval';
import { registerToolModule } from './toolModules';

/** A request reads the PR (or GitLab MR), the issue, the repository and the
 *  gh or glab login from its host first. */
const REQUEST_TIMEOUT_MS = 60_000;

const NUMBER = z.number().int().positive();
const STATES = ['pending', 'approved', 'denied', 'undone', 'executed', 'refused', 'expired'] as const satisfies readonly ApprovalState[];

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

registerToolModule({
  name: 'bot-approvals',
  tools: ['approval_request', 'approval_list'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>, timeoutMs?: number) => ({
      ...(await deps.callRpc(method, compact(params), timeoutMs)),
    });

    host.tool(
      'approval_request',
      'Ask the owner to approve an irreversible or public act: merge a PR of your repository, comment on a PR or an issue under the owner\'s name, '
        + 'open an issue, close an issue, close a PR without merging, or publish a release. Your workers cannot do these themselves. A card with '
        + 'Approve / Deny appears in your thread (Always allow for a merge); list the requests to the owner there. Once approved, wmux does it itself '
        + 'after a 10 s Undo window, re-checking what it acts on: a merge (the head and CI), a comment or an issue (exactly the text the card showed), '
        + 'a close (the issue or PR still open, a PR at the same head); a moved head or a closed target needs a new request. On GitLab only a merge '
        + 'is carried out. A release is recorded only for now. Returns the request (requestId, state); to the owner it is the approval card, never its requestId.',
      {
        action: z.enum(BOT_REQUESTABLE_ACTIONS as unknown as [ApprovalAction, ...ApprovalAction[]]),
        pr_number: NUMBER.optional().describe('merge, pr_close, or a comment on a PR.'),
        issue_number: NUMBER.optional().describe('issue_close, or a comment on an issue.'),
        body: z.string().min(1).max(6000).optional().describe('comment (required) or issue_create: the Markdown text to publish, exactly as the owner should read it on the card. wmux adds one hidden marker line.'),
        title: z.string().min(1).max(256).optional().describe('issue_create: the issue\'s title, one line.'),
        state_reason: z.enum(['completed', 'not_planned']).optional().describe('issue_close: why it closes (default completed).'),
        reason: z.string().min(1).max(300).describe('One line for the owner, in your own words and in the owner\'s language (the wake block says which): what this act does and what you checked. The owner reads it on the approval card. Never quote the owner\'s messages.'),
      },
      async ({ action, pr_number, issue_number, reason, body, title, state_reason }) =>
        call(BOT_APPROVAL_RPC.request, { action, prNumber: pr_number, issueNumber: issue_number, reason, body, title, stateReason: state_reason }, REQUEST_TIMEOUT_MS),
    );

    host.tool(
      'approval_list',
      'Your approval requests, newest first: requestId, act, PR or issue, head, state (pending, approved, denied, executed, refused with a reason, expired).',
      {
        state: z.array(z.enum(STATES)).min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ state, limit }) => call(BOT_APPROVAL_RPC.list, { state, limit }),
    );
  },
});
