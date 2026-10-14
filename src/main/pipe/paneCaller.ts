// ─── The pane behind a pipe call ─────────────────────────────────────────────
//
// Identity is server-resolved, never taken from params:
//   - the caller's senderPtyId (the MCP server's PID-walk hit) resolves to the
//     workspace that owns that pane right now; an unresolved pane, a missing
//     one, or a commander/bot session (no pane of its own) is no caller;
//   - the agent is the slug of the caller's MCP client name;
//   - the cwd is the one wmux reports for that pane.

import type { RpcContext } from '../../shared/rpc';
import type { AgentSlug } from '../../shared/agentIdentity';

export interface PaneCaller {
  ptyId: string;
  workspaceId: string;
  agent: AgentSlug | 'unknown';
}

export interface PaneCallerDeps {
  /** The workspace that owns this pane now, or null. */
  resolvePtyWorkspace: (ptyId: string) => Promise<string | null>;
  /** The cwd wmux knows for this pane ('' when none). */
  paneCwd: (ptyId: string, workspaceId: string) => string;
}

/** The agent slug for an MCP client name (the same slugs the daemon stamps on
 *  approval records). Substring order is deliberate (an `openclaude` client
 *  reads as claude); the return type ties every answer to a registry slug. */
export function agentSlugOf(clientName: string | undefined): AgentSlug | 'unknown' {
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('gemini')) return 'gemini';
  return 'unknown';
}

const PARAM_KEYS_OF_IDENTITY = ['senderPtyId'];

/** The input the caller sent, without the identity fields the MCP layer adds. */
export function bodyOf(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!PARAM_KEYS_OF_IDENTITY.includes(k)) out[k] = v;
  return out;
}

/** The calling pane, its workspace now, its agent and its own cwd, from the
 *  verified senderPtyId only; null for a brain, a hosted workspace or a
 *  caller wmux cannot tie to a pane. */
export async function resolvePaneCaller(
  deps: PaneCallerDeps,
  params: Record<string, unknown>,
  ctx?: RpcContext,
): Promise<{ asker: PaneCaller; cwd: string } | null> {
  if (ctx?.commanderWorkspace || ctx?.hostedWorkspace !== undefined) return null;
  const ptyId = typeof params.senderPtyId === 'string' ? params.senderPtyId.trim() : '';
  if (!ptyId) return null;
  let workspaceId: string | null;
  try {
    workspaceId = await deps.resolvePtyWorkspace(ptyId);
  } catch {
    workspaceId = null;
  }
  if (!workspaceId) return null;
  return { asker: { ptyId, workspaceId, agent: agentSlugOf(ctx?.clientName) }, cwd: deps.paneCwd(ptyId, workspaceId) };
}
