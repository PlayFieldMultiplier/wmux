// ─── task_push — a worker publishes its own task branch ─────────────────────
//
// Every profile (full + core), worker-scoped: the `task.push` pipe RPC
// (src/main/pipe/handlers/taskPush.rpc.ts) resolves the caller's task from the
// server-verified senderPtyId and pushes that task's branch to origin itself.
// The tool takes no arguments: there is no branch, remote or refspec for a
// caller to name.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';

/** Mirrors main's TASK_PUSH_TIMEOUT_MS (worktask/taskPush.ts) plus headroom for
 *  the reads before it; restated, not imported (this file is bundled into the
 *  MCP server). */
const TASK_PUSH_RPC_TIMEOUT_MS = 150_000;

export interface TaskPushToolDeps {
  /** The server's OWN verified senderPtyId (PID-map walk hit, '' on miss). */
  getSenderPtyId?: () => string;
  /** Warms the walk that populates the ptyId above (see fanout.ts). */
  resolveWorkspaceId?: () => Promise<string>;
}

export function registerTaskPushTool(server: McpServer, deps: TaskPushToolDeps): void {
  const resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');
  server.tool(
    'task_push',
    'Push YOUR fan-out task branch to origin (fast-forward only, upstream set). Commit first. wmux pushes the branch of the task in your own workspace; there is nothing to name. Then open the PR with gh pr create --head <your branch>.',
    {},
    async () => {
      if (deps.resolveWorkspaceId) {
        try {
          await deps.resolveWorkspaceId();
        } catch {
          // The handler refuses an unresolvable caller with its own message.
        }
      }
      const params: Record<string, unknown> = {};
      const pty = resolveSenderPtyId();
      if (pty) params['senderPtyId'] = pty;
      try {
        // Outwait main's push (TASK_PUSH_TIMEOUT_MS, 120 s, plus its reads).
        const result = (await sendRpc('task.push' as RpcMethod, params, TASK_PUSH_RPC_TIMEOUT_MS)) as { ok?: boolean } | undefined;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? {}, null, 2) }],
          ...(result && result.ok === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
