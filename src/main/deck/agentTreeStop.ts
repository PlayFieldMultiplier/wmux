// ─── Stopping an agent process wmux spawned, with what it started (POSIX) ───
//
// A My Hermes agent (`hermes -p <profile> acp`) runs the owner's tools as its
// children, and Hermes starts each tool command in its own session
// (`start_new_session=True`), so neither a signal to the agent nor one to its
// process group reaches them, and once the agent is gone they are orphans
// that keep running as the owner. So the tree is read first, by parent PID,
// with each process's start time (an exited one waiting to be reaped counts
// as gone); then:
// 1. SIGINT to the agent alone, which lets Hermes run its own cleanup of its
//    tool groups (its ACP entry catches KeyboardInterrupt and exits), and up
//    to `interruptWaitMs` for it to exit;
// 2. SIGTERM to every process of the snapshot still alive, then after
//    `termGraceMs` SIGKILL to those still alive.
// A process is signalled only while its PID still has the start time read in
// the snapshot, so a PID the OS reused meanwhile is never touched, and
// nothing outside the snapshot is ever signalled. Windows uses its tree kill
// (taskkill /T), not this.

import { execFile } from 'node:child_process';

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** The start time as `ps` prints it; compared as text only. */
  start: string;
  /** Exited, waiting to be reaped: nothing left to stop. */
  zombie?: boolean;
}

export interface AgentTreeStopDeps {
  /** The process table (default: `ps -A -o pid=,ppid=,stat=,lstart=`); null when it cannot be read. */
  table?: () => Promise<ProcRow[] | null>;
  /** Send a signal (default: process.kill). */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  interruptWaitMs?: number;
  termGraceMs?: number;
  pollMs?: number;
}

const INTERRUPT_WAIT_MS = 3_000;
const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;

/** `ps -A -o pid=,ppid=,stat=,lstart=` output as rows. Pure. */
export function parseProcTable(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[4], ...(m[3].startsWith('Z') ? { zombie: true } : {}) });
  }
  return rows;
}

/** `root` and every process below it by parent PID. Pure. */
export function treeOf(root: number, rows: readonly ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const top = rows.find((r) => r.pid === root);
  if (!top) return [];
  const out: ProcRow[] = [];
  const seen = new Set<number>();
  const stack = [top];
  while (stack.length > 0) {
    const r = stack.pop() as ProcRow;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    out.push(r);
    for (const c of byParent.get(r.pid) ?? []) stack.push(c);
  }
  return out;
}

function readTable(): Promise<ProcRow[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      resolve(err ? null : parseProcTable(String(stdout)));
    });
  });
}

/** The snapshot's processes that are still the same processes (PID and start time). */
async function stillAlive(snapshot: readonly ProcRow[], table: () => Promise<ProcRow[] | null>): Promise<ProcRow[]> {
  const now = await table();
  if (!now) return [];
  const live = new Map(now.filter((r) => !r.zombie).map((r) => [r.pid, r.start]));
  return snapshot.filter((r) => live.get(r.pid) === r.start);
}

/** Stop the agent `pid` and every process it started (see the head of this
 *  file). Resolves once they are gone or signalled with SIGKILL. When the
 *  table cannot be read, only the agent is signalled. Never throws. */
export async function stopAgentTree(pid: number, deps: AgentTreeStopDeps = {}): Promise<void> {
  const table = deps.table ?? readTable;
  const signal = deps.signal ?? ((p: number, sig: NodeJS.Signals) => { process.kill(p, sig); });
  const send = (p: number, sig: NodeJS.Signals): void => {
    try {
      signal(p, sig);
    } catch {
      /* already gone */
    }
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const poll = deps.pollMs ?? POLL_MS;
  const snapshot = treeOf(pid, (await table()) ?? []);
  if (snapshot.length === 0) {
    // No table (or the agent already went): the agent alone, as before.
    send(pid, 'SIGTERM');
    return;
  }
  const agent = snapshot[0];
  // 1. Hermes's own cleanup first.
  send(agent.pid, 'SIGINT');
  const until = Date.now() + (deps.interruptWaitMs ?? INTERRUPT_WAIT_MS);
  let live = await stillAlive(snapshot, table);
  while (live.length > 0 && live.some((r) => r.pid === agent.pid) && Date.now() < until) {
    await sleep(poll);
    live = await stillAlive(snapshot, table);
  }
  // 2. What is left of the snapshot.
  if (live.length === 0) return;
  for (const r of live) send(r.pid, 'SIGTERM');
  const graceUntil = Date.now() + (deps.termGraceMs ?? TERM_GRACE_MS);
  live = await stillAlive(live, table);
  while (live.length > 0 && Date.now() < graceUntil) {
    await sleep(poll);
    live = await stillAlive(live, table);
  }
  for (const r of live) send(r.pid, 'SIGKILL');
}
