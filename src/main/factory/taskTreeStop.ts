// #2388: an ended bot task's panes go with their whole process trees before
// the renderer closes them (its close ends only each pane). The same stop as
// the owner's (stopTaskWorker): the task folder's sessions among the panes
// about to close, destroyed with `killTree`, survivors recorded against the
// folder (stopSessionsInDir) so its cleanup keeps it while one runs.

import { stopSessionsInDir, type SessionsInDirPort } from '../worktask/stopSessionsInDir';
import type { DaemonDestroySessionTree } from '../../shared/rpc';
import type { WorkerSessionInfo } from './workerReclaim';

export interface TaskTreeStopPorts {
  /** The task's folder (its mission), null when not known. */
  folderOf: (taskId: string) => Promise<string | null>;
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** `daemon.destroySession` with `killTree`: the tree it reports on. */
  destroyTree: (id: string) => Promise<DaemonDestroySessionTree | void>;
  isAlive: SessionsInDirPort['isAlive'];
  sleep: SessionsInDirPort['sleep'];
  realpath?: SessionsInDirPort['realpath'];
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

/** A session that runs an agent or a command. A dead or suspended one runs
 *  nothing, whatever its last prompt state said. */
function busy(x: WorkerSessionInfo): boolean {
  const state = (x as { state?: unknown }).state;
  return state !== 'dead' && state !== 'suspended' && (x.agentProcessAlive === true || x.commandRunning === true);
}

/**
 * Stop the trees of the task folder's sessions among `ptyIds`. Throws, with
 * nothing stopped, when the folder is not known (survivors could not be
 * recorded against it), when the close is no longer due (`stillDue`), or
 * when any of `ptyIds` runs an agent or a command again, inside the folder
 * or not: the close that follows ends them all. Both are asked again right
 * before each kill (the kills are one at a time), and once more after the
 * last; a throw then leaves the rest, and what was stopped stays recorded.
 */
export async function stopTaskPaneTrees(ports: TaskTreeStopPorts, taskId: string, ptyIds: readonly string[], stillDue: () => boolean): Promise<void> {
  if (ptyIds.length === 0) return;
  const dir = await ports.folderOf(taskId);
  if (!dir) throw new Error(`the folder of task ${taskId} is not known`);
  const check = (sessions: readonly WorkerSessionInfo[]): void => {
    if (!stillDue()) throw new Error(`the close of task ${taskId}'s panes is no longer due`);
    const running = sessions.filter(busy);
    if (running.length > 0) throw new Error(`${running.map((x) => x.id).join(', ')} of task ${taskId} run(s) again`);
  };
  const targets = async (): Promise<WorkerSessionInfo[]> => (await ports.listSessions()).filter((x) => ptyIds.includes(x.id));
  await stopSessionsInDir(dir, {
    listSessions: async () => {
      const list = await targets();
      check(list);
      return list;
    },
    destroySession: async (id) => {
      check((await targets()).filter((x) => x.id === id));
      return ports.destroyTree(id);
    },
    isAlive: ports.isAlive,
    sleep: ports.sleep,
    ...(ports.realpath ? { realpath: ports.realpath } : {}),
    ...(ports.platform ? { platform: ports.platform } : {}),
    ...(ports.log ? { log: ports.log } : {}),
  });
  // Once more after the last kill, which may have taken a while: the close
  // that follows ends every pane passed in.
  check(await targets());
}
