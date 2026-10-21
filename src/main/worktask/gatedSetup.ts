// The setup command under the machine-wide gate permit, as a fan-out's setup
// runs it: an install never overlaps a task gate. Only the command takes the
// permit; a worktree with nothing to set up never waits for one.
import { runFanoutSetup, type FanoutSetupRunResult } from './fanoutEnvironment';
import { getSharedTaskGateRunner } from './TaskGateRunner';

export function gatedSetup(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<FanoutSetupRunResult> {
  const gates = getSharedTaskGateRunner();
  const run = () => runFanoutSetup(command, cwd, env, timeoutMs);
  return gates ? gates.withPermit(run) : run();
}
