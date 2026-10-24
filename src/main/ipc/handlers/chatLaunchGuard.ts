import { CHATV2_LAUNCH_ALLOWED_RPC } from '../../../shared/chatv2/ipc';

/**
 * Whether the daemon lets `line`, which starts an agent (a resume, a launch),
 * be typed into `paneId`: false while chat v2 owns the pane, a move holds it,
 * or the line names a conversation an active chat holds. A daemon without the
 * method has no move into chat, so it allows; any other failure refuses, since
 * the answer decides whether a second process may join a conversation. The
 * pipe carries no error code, so an old daemon is told by its error text.
 */
export async function launchAllowedByChat(
  client: { rpc(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown> },
  paneId: string,
  line: string,
): Promise<boolean> {
  try {
    const result = await client.rpc(CHATV2_LAUNCH_ALLOWED_RPC, { paneId, line }, { timeoutMs: 5_000 }) as { allowed?: unknown } | null;
    return result?.allowed === true;
  } catch (error) {
    return error instanceof Error && error.message === `Unknown method: ${CHATV2_LAUNCH_ALLOWED_RPC}`;
  }
}
