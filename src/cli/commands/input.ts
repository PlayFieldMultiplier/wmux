import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault, type SelfContext } from '../identity';
import type { RpcMethod, RpcResponse } from '../../shared/rpc';

type Rpc = (method: RpcMethod, params?: Record<string, unknown>) => Promise<RpcResponse>;

/** The explicit target: `--to` or its older spelling `--pane` (a ptyId or a `#pane` name). */
export function explicitTarget(args: string[]): string | undefined {
  return parseFlag(args, '--to') ?? parseFlag(args, '--pane');
}

/**
 * A `#name` target (`#w1-2`, `#backend`, as pane_list's paneTag shows it) →
 * that pane's terminal ptyId, through `pane.resolveName`. Anything else is a
 * ptyId and passes through unchanged. Throws with wmux's own reason on a miss.
 */
export async function resolveExplicitTarget(value: string, rpc: Rpc): Promise<string> {
  const trimmed = value.trim();
  if (trimmed.charAt(0) !== '#') return value;
  const response = await rpc('pane.resolveName', { name: trimmed });
  if (!response.ok) throw new Error(response.error);
  const res = response.result as { ok?: unknown; error?: unknown; target?: { ptyId?: unknown; paneTag?: unknown } } | null;
  if (!res || res.ok !== true || !res.target) {
    throw new Error(res && typeof res.error === 'string' ? res.error : `no pane named "${trimmed}"`);
  }
  if (typeof res.target.ptyId !== 'string' || !res.target.ptyId) {
    throw new Error(`pane ${String(res.target.paneTag ?? trimmed)} has no local terminal`);
  }
  return res.target.ptyId;
}

/**
 * The agent running in pane `ptyId`, from a `pane.list` result: its tag and
 * agent name, or undefined when no agent is detected there.
 */
export function agentInPane(paneList: unknown, ptyId: string): { paneTag?: string; agentName: string } | undefined {
  const panes = (paneList as { panes?: unknown } | null)?.panes;
  if (!Array.isArray(panes)) return undefined;
  for (const pane of panes as Array<{ paneTag?: unknown; agents?: unknown }>) {
    if (!Array.isArray(pane?.agents)) continue;
    const agent = (pane.agents as Array<{ ptyId?: unknown; agentName?: unknown }>).find((a) => a?.ptyId === ptyId);
    if (agent && typeof agent.agentName === 'string' && agent.agentName) {
      return { ...(typeof pane.paneTag === 'string' ? { paneTag: pane.paneTag } : {}), agentName: agent.agentName };
    }
  }
  return undefined;
}

/**
 * A send or key that resolved to the caller's OWN pane (no `--to`/`--pane`/
 * `--active`) while an agent runs there types into that agent's input. When
 * the caller is that agent (its shell tool runs `wmux send`), the text never
 * reaches another pane. Returns the warning to print, or undefined. Best
 * effort: an unanswered pane.list prints nothing.
 */
export async function selfTargetWarning(target: Record<string, unknown>, rpc: Rpc): Promise<string | undefined> {
  if (typeof target.ptyId !== 'string' || !target.ptyId) return undefined;
  let response: RpcResponse;
  try {
    response = await rpc('pane.list', typeof target.workspaceId === 'string' ? { workspaceId: target.workspaceId } : {});
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const agent = agentInPane(response.result, target.ptyId);
  if (!agent) return undefined;
  const pane = agent.paneTag ? `pane ${agent.paneTag}` : 'this pane';
  return `Warning: no target given, so this went to your own ${pane}, where ${agent.agentName} is running: ` +
    'it was typed into that agent\'s input, not into any other pane. ' +
    'To reach another pane, pass --to <#pane|ptyId> (see `wmux list-panes`).';
}

/**
 * Resolve the routing params for a terminal-IO command.
 *
 *   --to <#pane|ptyId> (or --pane) → explicit target (no identity lookup)
 *   --active        → legacy behavior: whatever pane is focused in the UI
 *   (default)       → self-targeting: the pane whose shell spawned this CLI,
 *                     resolved via the verified PID-map walk. Falls back to
 *                     active-pane when not inside a wmux pane.
 *
 * Returned params carry workspaceId alongside ptyId so the main process
 * asserts ownership (assertWorkspaceOwnsPty) — self-targeting can never
 * write into a foreign workspace even if the map were wrong.
 *
 * `mode` handles the workspace-only identity case (older main that returns
 * `mappings` without pane-level `entries`):
 *   - 'require-pty' (send/send-key): a workspaceId WITHOUT a ptyId would make
 *     the server resolve the globally focused pane and then hard-fail the
 *     ownership assert whenever the user is viewing another workspace — worse
 *     than the pre-X4 CLI. Drop the identity entirely → pure active-pane.
 *   - 'workspace-scope-ok' (read-screen): the server forwards workspaceId to
 *     the renderer, which resolves the CALLER's own active pane scoped to
 *     that workspace — workspace-only identity is an improvement there.
 */
export async function resolveTargetParams(
  args: string[],
  mode: 'require-pty' | 'workspace-scope-ok',
): Promise<Record<string, unknown>> {
  const explicitPane = explicitTarget(args);
  if (explicitPane) return { ptyId: await resolveExplicitTarget(explicitPane, sendRequest) };
  // A target flag whose value went missing must not fall back to this pane: an
  // unquoted `--to #w1-2` loses its value to the shell (`#` starts a comment).
  for (const flag of ['--to', '--pane']) {
    if (hasFlag(args, flag)) throw new Error(`${flag} needs a pane: a ptyId or a quoted '#name' (an unquoted # starts a shell comment)`);
  }
  if (hasFlag(args, '--active')) return {};

  const ctx: SelfContext = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
  });
  if (mode === 'require-pty' && !ctx.ptyId) return {};
  const params: Record<string, unknown> = {};
  if (ctx.ptyId) params.ptyId = ctx.ptyId;
  if (ctx.workspaceId) params.workspaceId = ctx.workspaceId;
  return params;
}

/** Strip routing/option flags so the remaining args are the text payload. */
export function stripInputFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pane' || a === '--to') {
      i++; // skip value
      continue;
    }
    if (a === '--active' || a === '--submit' || a === '--raw') continue;
    out.push(a);
  }
  return out;
}

/** resolveTargetParams for a command: an unresolvable `#pane` exits with wmux's reason. */
async function targetOrExit(args: string[], mode: 'require-pty' | 'workspace-scope-ok' = 'require-pty'): Promise<Record<string, unknown>> {
  try {
    return await resolveTargetParams(args, mode);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function handleInput(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'send': {
      const text = stripInputFlags(args).join(' ');
      if (!text) {
        console.error('Error: send requires <text>');
        process.exit(1);
      }
      const target = await targetOrExit(args);
      const params: Record<string, unknown> = { text, ...target };
      if (hasFlag(args, '--submit')) params.submit = true;
      if (hasFlag(args, '--raw')) params.raw = true;
      response = await sendRequest('input.send', params);
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(params.submit ? 'Text sent and submitted.' : 'Text sent.');
      }
      if (!explicitTarget(args) && !hasFlag(args, '--active')) {
        const warning = await selfTargetWarning(target, sendRequest);
        if (warning) console.error(warning);
      }
      break;
    }

    case 'send-key': {
      const key = stripInputFlags(args)[0];
      if (!key) {
        console.error('Error: send-key requires <keystroke>');
        process.exit(1);
      }
      const target = await targetOrExit(args);
      response = await sendRequest('input.sendKey', { key, ...target });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Key sent: ${key}`);
      }
      if (!explicitTarget(args) && !hasFlag(args, '--active')) {
        const warning = await selfTargetWarning(target, sendRequest);
        if (warning) console.error(warning);
      }
      break;
    }

    case 'read-screen': {
      const target = await targetOrExit(args, 'workspace-scope-ok');
      const params: Record<string, unknown> = { ...target };
      const tail = parseFlag(args, '--tail');
      if (tail && Number.isFinite(parseInt(tail, 10))) {
        params.tail_lines = parseInt(tail, 10);
      }
      response = await sendRequest('input.readScreen', params);
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        // server returns { text: string } object or plain string
        const result = response.result as { text?: string } | string;
        let screen: string;
        if (typeof result === 'object' && result !== null && 'text' in result) {
          screen = result.text ?? '';
        } else if (typeof result === 'string') {
          screen = result;
        } else {
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        process.stdout.write(screen);
        if (!screen.endsWith('\n')) process.stdout.write('\n');
      }
      break;
    }

    default:
      console.error(`Unknown input command: ${cmd}`);
      process.exit(1);
  }
}
