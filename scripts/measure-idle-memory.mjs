#!/usr/bin/env node
// Idle-agent memory baseline (PRD E0 R0-3).
//
// Opens real agents (default 5 claude + 5 codex) as terminal tabs in a fresh
// workspace of the RUNNING wmux, lets them settle at their prompts, samples
// memory, then closes the workspace. No prompt is sent, so no model tokens are
// spent. The workspace is never focused: idle agents usually sit in the
// background, and that is the state hibernation (PRD P5) would act on.
//
// Memory follows docs/performance.md's process-tree grouping
// (src/cli/memoryDiagnostics.ts), computed here from one `ps` sample so it
// also works against releases older than `doctor --performance`'s memory
// fields: app (Electron main + helpers), daemon, workloads (everything the
// daemon runs: shells, agents, MCP servers). Each opened agent's own process
// tree (its shell and everything under it) is reported per agent kind. The
// script's own process tree is excluded. RSS excludes swapped and compressed
// pages, and shared pages count once per process.
//
// Run it from the folder the agents should start in; it must be one both CLIs
// already trust, or they stop at a trust prompt before starting MCP servers
// (the report flags any pane whose screen still asks).
//
// Usage: node scripts/measure-idle-memory.mjs [--claude 5] [--codex 5]
//          [--settle 60] [--samples 3] [--interval 10] [--app-pid <pid>] [--keep] [--json]
// macOS and Linux only (`ps`). Honors WMUX_DATA_SUFFIX like the CLI does.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findAppPid, groupMemory, median, medianOf, parsePsRows, treeRss } from './lib/idle-memory.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const num = (name, fallback) => {
  const v = Number(flag(name, fallback));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} takes a number`);
  return v;
};
const KINDS = [
  { kind: 'claude', count: num('--claude', 5) },
  { kind: 'codex', count: num('--codex', 5) },
].filter((k) => k.count > 0);
const SETTLE_MS = num('--settle', 60) * 1000;
const SAMPLES = Math.max(1, num('--samples', 3));
const INTERVAL_MS = num('--interval', 10) * 1000;
const APP_PID = flag('--app-pid') ? Number(flag('--app-pid')) : undefined;
const KEEP = argv.includes('--keep');
const JSON_OUT = argv.includes('--json');

const SUFFIX = process.env.WMUX_DATA_SUFFIX ?? '';
const HOME = os.homedir();
const WMUX_HOME = path.join(HOME, `.wmux${SUFFIX}`);
const SOCKET = path.join(HOME, `.wmux${SUFFIX}.sock`);
const TOKEN = path.join(HOME, `.wmux${SUFFIX}-auth-token`);
/** The pipe client name the CLI reports (WMUX_CLI_CLIENT_NAME in src/shared/rpc.ts). */
const CLIENT_NAME = 'wmux-cli';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** One request on the app's pipe, framed like src/cli/client.ts. */
function rpc(method, params = {}) {
  const token = fs.readFileSync(TOKEN, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.connect(SOCKET);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method}: timed out`));
    }, 30_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params, token, clientName: CLIENT_NAME })}\n`));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (const line of buf.split('\n').slice(0, -1)) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        socket.destroy();
        if (msg.ok === false) reject(new Error(`${method}: ${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}`));
        else if (msg.result && typeof msg.result === 'object' && 'error' in msg.result) reject(new Error(`${method}: ${msg.result.error}`));
        else resolve(msg.result);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** One `ps` sample of every process. */
const psRows = () =>
  parsePsRows(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));

function appPidOf(rows) {
  if (APP_PID !== undefined) return APP_PID;
  const pid = findAppPid(rows);
  if (pid === undefined) throw new Error('could not tell which process is the wmux app; pass --app-pid <pid>');
  return pid;
}

function daemonPid() {
  const pid = Number(fs.readFileSync(path.join(WMUX_HOME, 'daemon.pid'), 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('daemon.pid is unreadable');
  return pid;
}

/** The pane shell's pid for a ptyId, from ~/.wmux/pid-map/<pid> (content: ptyId). */
function shellPidFor(ptyId) {
  const dir = path.join(WMUX_HOME, 'pid-map');
  for (const name of fs.readdirSync(dir)) {
    try {
      if (fs.readFileSync(path.join(dir, name), 'utf8').trim() === ptyId) return Number(name);
    } catch {
      /* removed while reading */
    }
  }
  return undefined;
}

/** One sample: the groups, and each agent's tree. */
function sample(appPid, dPid, agents) {
  const rows = psRows();
  return {
    groups: groupMemory(rows, appPid, dPid, process.pid),
    agents: agents.map((a) => ({ kind: a.kind, ptyId: a.ptyId, ...(a.shellPid ? treeRss(rows, a.shellPid) : { rssBytes: 0, processes: 0 }) })),
  };
}

async function sampleMedian(appPid, dPid, agents) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await sleep(INTERVAL_MS);
    samples.push(sample(appPid, dPid, agents));
  }
  return medianOf(samples);
}

const mib = (b) => `${(b / 1024 / 1024).toFixed(1)} MiB`;

function format(r) {
  const lines = [
    `idle-agent memory: ${KINDS.map((k) => `${k.count} ${k.kind}`).join(' + ')} | settle ${r.settleMs / 1000}s, median of ${r.samples} samples`,
    '',
    'group          before        with agents   delta',
  ];
  for (const k of ['app', 'appMain', 'appRenderer', 'appHelpers', 'daemon', 'workloads']) {
    const b = r.before.groups[k].rssBytes;
    const a = r.after.groups[k].rssBytes;
    lines.push(`${k.padEnd(14)} ${mib(b).padStart(12)}  ${mib(a).padStart(12)}  ${mib(a - b).padStart(11)}`);
  }
  lines.push('', 'per agent (its shell and every process under it):');
  for (const kind of [...new Set(r.after.agents.map((a) => a.kind))]) {
    const list = r.after.agents.filter((a) => a.kind === kind);
    const rss = list.map((a) => a.rssBytes);
    lines.push(`  ${kind.padEnd(7)} n=${list.length}  avg ${mib(rss.reduce((s, x) => s + x, 0) / list.length)}  min ${mib(Math.min(...rss))}  max ${mib(Math.max(...rss))}  processes ${median(list.map((a) => a.processes))}`);
  }
  const total = r.after.agents.reduce((s, a) => s + a.rssBytes, 0);
  lines.push(`  all      ${mib(total)}`);
  if (r.notReady.length > 0) lines.push('', `WARNING: not at a ready prompt (trust/login screen?): ${r.notReady.join(', ')}`);
  if (r.teardown) lines.push('', `after closing: workloads ${mib(r.teardown.groups.workloads.rssBytes)}, agent shells still alive ${r.teardownAlive}`);
  return lines.join('\n');
}

/** First-run screens that stop an agent before it starts its MCP servers. */
const NOT_READY_RE = /Do you trust|trust the (files|contents)|work in this folder|Select login method|Choose the text style/i;

async function main() {
  for (const { kind } of KINDS) execFileSync('which', [kind], { stdio: 'ignore' });
  const rows0 = psRows();
  const appPid = appPidOf(rows0);
  const dPid = daemonPid();
  if (!rows0.has(dPid)) throw new Error(`daemon pid ${dPid} is not running`);
  log(`app pid ${appPid}, daemon pid ${dPid}; sampling the baseline…`);
  const before = await sampleMedian(appPid, dPid, []);

  const ws = await rpc('workspace.new', { name: `idle-memory-${new Date().toISOString().slice(11, 19)}` });
  const workspaceId = ws?.id ?? ws?.workspace?.id;
  if (typeof workspaceId !== 'string') throw new Error(`workspace.new returned no id: ${JSON.stringify(ws)}`);
  const agents = [];
  try {
    for (const { kind, count } of KINDS) {
      for (let i = 0; i < count; i++) {
        const s = await rpc('surface.new', { workspaceId, cwd: process.cwd() });
        if (typeof s?.ptyId !== 'string') throw new Error(`surface.new returned no ptyId: ${JSON.stringify(s)}`);
        const agent = { kind, ptyId: s.ptyId, shellPid: undefined };
        for (let t = 0; t < 40 && !agent.shellPid; t++) {
          await sleep(250);
          agent.shellPid = shellPidFor(s.ptyId);
        }
        await sleep(1_000); // let the shell draw its prompt
        await rpc('input.send', { ptyId: s.ptyId, text: kind, submit: true });
        agents.push(agent);
        log(`started ${kind} in ${s.ptyId} (shell pid ${agent.shellPid ?? '?'})`);
      }
    }
    log(`settling ${SETTLE_MS / 1000}s…`);
    await sleep(SETTLE_MS);
    const notReady = [];
    for (const a of agents) {
      const screen = await rpc('input.readScreen', { ptyId: a.ptyId, tail_lines: 25 }).catch(() => null);
      const text = typeof screen === 'string' ? screen : screen?.text ?? '';
      if (NOT_READY_RE.test(text)) notReady.push(`${a.kind}:${a.ptyId}`);
    }
    log('sampling with agents…');
    const after = await sampleMedian(appPid, dPid, agents);
    const report = { settleMs: SETTLE_MS, samples: SAMPLES, agents: agents.map(({ kind, ptyId }) => ({ kind, ptyId })), before, after, notReady };
    if (!KEEP) {
      await rpc('workspace.close', { id: workspaceId, force: true });
      await sleep(5_000);
      const rows = psRows();
      report.teardown = sample(appPid, dPid, []);
      report.teardownAlive = agents.filter((a) => a.shellPid && rows.has(a.shellPid)).length;
    }
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else console.log(`\n${format(report)}`);
  } catch (err) {
    if (!KEEP) {
      await rpc('workspace.close', { id: workspaceId, force: true }).catch(() => {
        /* best effort: the original error is the one to report */
      });
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(`measure-idle-memory: ${err.message}`);
  process.exit(1);
});
