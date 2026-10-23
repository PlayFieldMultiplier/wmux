import { sendRequest } from '../client';
import { parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import type { RpcMethod, RpcResponse } from '../../shared/rpc';
import { A2A_SPAWN_PIPE_RPC, type A2aSpawnAskResult, type A2aSpawnOutgoingList } from '../../shared/a2aSpawn';

export const REMOTE_HELP = `
wmux remote — ask a paired PC to start an agent

  wmux remote spawn <pc> --agent <slug> --root <id> [--sub <path>] [--hours <1-72>] [--] <prompt…>
      Ask <pc> (its name here, or its host id) to start <slug> in folder <id>
      (and <path> under it). The agent's replies come to this pane as a task.
      That PC decides on its own card or rule; when it is off, the request
      waits for it (24 hours unless --hours says otherwise).
  wmux remote spawn-status [<spawnId>]
      Your requests and their state, and what each paired PC lets you ask for.

  --json prints the raw RPC payload.
`;

/** The verified pane identity (PID walk), or ''. The env hint is not used: main resolves the caller from it. */
async function senderPtyId(): Promise<string> {
  try {
    const ctx = await resolveSelfContext({ sendRequest, env: process.env, ppid: process.ppid, getParentPid: getParentPidDefault });
    return ctx.ptyId ?? '';
  } catch {
    return '';
  }
}

async function call(method: RpcMethod, params: Record<string, unknown>, jsonMode: boolean): Promise<Record<string, unknown>> {
  let response: RpcResponse;
  try {
    response = await sendRequest(method, params);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
  const result = (response.result ?? {}) as Record<string, unknown>;
  if (result['ok'] === false && jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (result['ok'] === false) {
    const err = result['error'];
    const text = typeof err === 'string'
      ? `${err}${typeof result['message'] === 'string' ? `: ${result['message']}` : ''}`
      : `[${(err as { code?: string })?.code ?? 'UNKNOWN'}] ${(err as { message?: string })?.message ?? 'refused'}`;
    console.error(`Error: ${text}`);
    process.exit(1);
  }
  return result;
}

/** The prompt: everything after a bare `--`, else the words that are not flags or flag values. */
function promptOf(args: string[]): string {
  const dash = args.indexOf('--');
  if (dash !== -1) return args.slice(dash + 1).join(' ');
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (['--agent', '--root', '--sub', '--hours'].includes(args[i])) i += 1;
    else words.push(args[i]);
  }
  return words.join(' ');
}

export async function handleRemote(sub: string | undefined, args: string[], jsonMode: boolean): Promise<void> {
  if (sub === 'spawn') {
    const pc = args[0] && !args[0].startsWith('-') ? args[0] : '';
    const rest = pc ? args.slice(1) : args;
    // Flags are read only before a bare `--`: the prompt may hold flag-like words.
    const before = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    const agent = parseFlag(before, '--agent');
    const root = parseFlag(before, '--root');
    const prompt = promptOf(rest).trim();
    const hours = parseFlag(before, '--hours');
    if (!pc || !agent || !root || !prompt || (hours !== undefined && !/^\d+$/.test(hours))) {
      console.error('Usage: wmux remote spawn <pc> --agent <slug> --root <id> [--sub <path>] [--hours <1-72>] [--] <prompt…>');
      process.exit(1);
    }
    const pty = await senderPtyId();
    if (!pty) {
      console.error('Error: not inside a wmux pane (no resolvable pane identity). The replies go to the pane that asks, so run this from one.');
      process.exit(1);
    }
    const subPath = parseFlag(before, '--sub');
    const result = (await call(A2A_SPAWN_PIPE_RPC.spawn, {
      pc, agent, root, prompt, senderPtyId: pty,
      ...(subPath ? { sub: subPath } : {}),
      ...(hours ? { expiresInHours: Number(hours) } : {}),
    }, jsonMode)) as A2aSpawnAskResult;
    if (jsonMode || !result.ok) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const name = result.spawn.hostName ?? result.spawn.hostId;
    console.log(result.online
      ? `Sent to ${name} (${result.spawn.spawnId}). It answers once it decides.`
      : `${name} is off. wmux will try to deliver the request before ${new Date(result.spawn.expiresAt).toLocaleString()}; ${name} decides whether the agent starts. (${result.spawn.spawnId})`);
    return;
  }
  if (sub === 'spawn-status') {
    const spawnId = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
    const result = (await call(A2A_SPAWN_PIPE_RPC.status, spawnId ? { spawnId } : {}, jsonMode)) as unknown as A2aSpawnOutgoingList;
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const r of result.requests) {
      console.log(`${r.spawnId}  ${r.hostName ?? r.hostId}  ${r.agent} in ${r.rootId}${r.sub ? `/${r.sub}` : ''}  ${r.state}${r.code ? ` (${r.code})` : ''}`);
    }
    if (!spawnId) {
      for (const p of result.places) {
        const what = !p.supported ? 'cannot take requests'
          : !p.targets ? 'has not said what you may ask for'
          : `folders: ${p.targets.roots.map((x) => x.id).join(', ') || 'none'}; agents: ${p.targets.agents.join(', ') || 'none'}`;
        console.log(`${p.name ?? p.hostId}${p.online ? '' : ' (off)'}: ${what}`);
      }
    }
    return;
  }
  console.log(REMOTE_HELP);
}
