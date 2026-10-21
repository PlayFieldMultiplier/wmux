// ─── The tool gate of a worker with a signed-in connection ─────────────────
//
// A PreToolUse hook (matcher `.*`) on every tool call of a bot's worker whose
// task has a signed-in connection (main/connectors/workerGateway.ts). It is an
// allowlist by tool name only: a call passes when it is
//   - Bash, which runs in the OS command sandbox (workerGatewaySandbox): every
//     file the worker reads or writes goes through it, so the sandbox decides
//     which folders it reaches;
//   - TodoWrite;
//   - one of the task's gateway connections' tools (the gateway holds the
//     owner's tool list), or wmux's ledger_update.
// Anything else is refused, the built-in file tools (Read, Write, Edit,
// MultiEdit, NotebookEdit, Glob, Grep) included: they run in claude's own
// process, outside the sandbox.
//
// The hook runs as `ELECTRON_RUN_AS_NODE=1 "<wmux>" "<script>" || exit 2`, so
// a gate that cannot run refuses. A hook that outlives its timeout does not
// block the call (measured on claude 2.1.305), so the gate does no I/O but
// reading the call, and its timeout is generous
// (WORKER_GATE_TIMEOUT_S).
//
// The script is plain JavaScript main writes per launch, content-named under
// `<wmuxDir>/factory/worker-hooks/`, with its allowlist in it.

/** The built-in tools a gated worker may call. */
export const WORKER_GATE_BUILTIN_TOOLS: readonly string[] = ['Bash', 'TodoWrite'];

/** The wmux tools a gated worker may call: it reports its task, nothing else. */
export const WORKER_GATE_WMUX_TOOLS: readonly string[] = ['ledger_update'];

/** The gate hook's timeout, in seconds. */
export const WORKER_GATE_TIMEOUT_S = 120;

/** The hook script for one launch: the allowlist for the task's gateway
 *  connections (their names). Pure. */
export function workerToolGateScript(connections: readonly string[]): string {
  const data = {
    tools: [...WORKER_GATE_BUILTIN_TOOLS, ...WORKER_GATE_WMUX_TOOLS.map((t) => `mcp__wmux__${t}`)],
    prefixes: connections.map((c) => `mcp__${c}__`),
  };
  return `'use strict';
// wmux: the tool gate of a bot worker with a signed-in connection (generated).
const P = ${JSON.stringify(data)};
function refuse(msg) { process.stderr.write('wmux: ' + msg + '\\n'); process.exit(2); }
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let name = '';
  try {
    name = String(JSON.parse(raw).tool_name || '');
  } catch {
    refuse('the tool gate could not read the call');
  }
  if (P.tools.includes(name) || P.prefixes.some((p) => name.startsWith(p) && name.length > p.length)) process.exit(0);
  refuse(name + ' is not available to a task with a signed-in connection; use Bash for files');
});
`;
}

/** The gate's hook command: this process's runtime by its absolute path, as
 *  node, so the worker's PATH does not choose it. Null when either path
 *  cannot be quoted safely. Pure. */
export function workerToolGateCommand(runtime: string, gate: string): string | null {
  const plain = (p: string) => /^\/[A-Za-z0-9._/ -]+$/.test(p);
  if (!plain(runtime) || !plain(gate)) return null;
  return `ELECTRON_RUN_AS_NODE=1 "${runtime}" "${gate}" || exit 2`;
}
