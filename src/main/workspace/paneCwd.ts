// A pane's own cwd, as main's workspace mirror knows it.
import { getWorkspaceMirror } from './WorkspaceMirror';

/** The pane's OWN cwd, with no workspace fallback ('' when wmux knows none):
 *  a caller's repo is resolved from it, so it must be that pane's. */
export function paneOwnCwdOf(ptyId: string, workspaceId: string): string {
  return getWorkspaceMirror().getFleetSnapshot(workspaceId)?.panes.find((p) => p.ptyId === ptyId)?.cwd ?? '';
}
