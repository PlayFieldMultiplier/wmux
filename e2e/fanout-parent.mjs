// A scripted fan-out parent for the cost baseline (PRD E0 R0-2): an ordinary
// agent pane that fans out three tasks and follows them to review_requested
// exactly the way the product tells it to, counting every MCP call and every
// character that comes back.
//
// It stands in for Claude Code in its pane: it draws the banner the detector
// keys on and reports its turns through the real hook bridge, so wmux treats
// it as a live, idle agent and types the fan-out nudge into it. The nudge
// arrives on stdin like a prompt.
//
// The loop is the protocol minimum, so every count is a lower bound for a
// real agent:
//   1. fanout_start, then re-send the same key every POLL_MS until completed
//      (= spawned);
//   2. end the turn and wait for a nudge;
//   3. per nudge: channel_mission_list (the nudge names it), then channel_read
//      on each task the nudge names, from the last seq already read;
//   4. done once every task's ledger row reached review_requested.
// Adopting is not attempted: the ordinary pane has no task_adopt tool.
//
// Writes the report to $HOME/.e2e-fanout-cost.json.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, sleep } from './lib.mjs';
import { connectWmuxMcp } from './mcpClient.mjs';

const POLL_MS = 3_000;
// The operator's first prompt comes a while after launch. Before the renderer's
// next liveness refresh (every 15 s) the pane does not count as a live agent,
// and a nudge that arrives then is dropped, not held.
const FIRST_PROMPT_DELAY_MS = 20_000;
const DEADLINE_MS = 4 * 60_000;
const REREAD_MS = 1_000;
const REREADS = 3;
const TITLES = ['Cost task A', 'Cost task B', 'Cost task C'];
const REPORT = path.join(os.homedir(), '.e2e-fanout-cost.json');
const BRIDGE = path.join(ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');
// Claude-shaped: the daemon refuses a resume binding for any other session id.
const SESSION = crypto.randomUUID();

/** One Claude hook through the real bridge, as Claude Code would fire it. */
function hook(event, extra = {}) {
  const input = JSON.stringify({ session_id: SESSION, hook_event_name: event, cwd: process.cwd(), ...extra });
  spawnSync(process.execPath, [BRIDGE, event], {
    input,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 15_000,
  });
}

/** A nudge as the parent reads it: the pasted line without terminal escapes. */
// eslint-disable-next-line no-control-regex
const clean = (line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z~]/g, '').replace(/[\u0000-\u001f]/g, '').trim();

/** Worker-written characters in one channel message read by the owner. */
function workerChars(msg, ownerWorkspaceId) {
  if (typeof msg?.text !== 'string') return 0;
  if (msg.workspaceId !== ownerWorkspaceId) return msg.text.length;
  // Ledger transitions are posted as the owner but quote the worker's summary.
  const m = /^\[ledger\] .* worker: "(.*)"$/s.exec(msg.text);
  return m ? m[1].length : 0;
}

process.stdout.write('\n Claude Code \n\n  bypass permissions on\n');
hook('SessionStart', { source: 'startup' });

const mcp = await connectWmuxMcp('wmux-e2e-parent');
const adoptAvailableViaMcp = (await mcp.tools()).includes('task_adopt');
await sleep(FIRST_PROMPT_DELAY_MS);

// Turn 1: start the fan-out and poll it to `completed`.
const started = Date.now();
hook('UserPromptSubmit', { prompt: 'fan out three tasks' });
const params = {
  idempotency_key: `e2e-cost-${process.pid}`,
  titles: TITLES,
  task_prompts: TITLES.map((t) => `${t}: make the change and report.`),
};
let res = await mcp.call('fanout_start', params);
let fanoutPolls = 0;
let ownerWorkspaceId = res.json?.ownerWorkspaceId ?? null;
while (res.json?.status !== 'completed' && Date.now() - started < DEADLINE_MS) {
  if (res.isError) break;
  await sleep(POLL_MS);
  res = await mcp.call('fanout_start', params);
  fanoutPolls++;
}
const tasks = (res.json?.result?.tasks ?? []).map((t) => ({
  taskId: t.taskId,
  channelId: t.channelId,
  shortId: String(t.taskId ?? '').replace(/^wtask-/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(-8),
  lastSeq: 0,
  workerChars: 0,
  reviewRequested: false,
}));
ownerWorkspaceId ??= res.json?.ownerWorkspaceId ?? null;
hook('Stop', { stop_hook_active: false });

const nudges = [];
let rereads = 0;

/** Read one task's mission channel from where we left off; true once review_requested is seen. */
async function readTask(task) {
  for (;;) {
    const r = await mcp.call('channel_read', { channel_id: task.channelId, since_seq: task.lastSeq + 1, limit: 50 });
    const messages = r.json?.messages ?? r.json?.result?.messages ?? [];
    for (const msg of messages) {
      task.lastSeq = Math.max(task.lastSeq, msg.seq ?? 0);
      task.workerChars += workerChars(msg, ownerWorkspaceId);
      if (typeof msg.text === 'string' && msg.text.startsWith('[ledger]') && msg.text.includes('→review_requested')) {
        task.reviewRequested = true;
      }
    }
    if (messages.length < 50) return task.reviewRequested;
  }
}

async function onNudge(line) {
  nudges.push(line);
  hook('UserPromptSubmit', { prompt: line });
  await mcp.call('channel_mission_list');
  for (const task of tasks.filter((t) => line.includes(t.shortId))) {
    if (await readTask(task)) continue;
    // The nudge said "ready for review" before the ledger line was readable.
    for (let i = 0; i < REREADS && !task.reviewRequested && /ready for review/.test(line); i++) {
      await sleep(REREAD_MS);
      rereads++;
      await readTask(task);
    }
  }
  hook('Stop', { stop_hook_active: false });
}

const allDone = () => tasks.length > 0 && tasks.every((t) => t.reviewRequested);
if (tasks.length > 0) {
  const rl = readline.createInterface({ input: process.stdin });
  const queue = [];
  let wake = null;
  rl.on('line', (raw) => {
    const line = clean(raw);
    if (!line.includes('[wmux] fan-out')) return;
    queue.push(line);
    wake?.();
  });
  while (!allDone() && Date.now() - started < DEADLINE_MS) {
    if (queue.length === 0) {
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 1_000);
      });
      wake = null;
      continue;
    }
    await onNudge(queue.shift());
  }
  rl.close();
}

const byTool = {};
const charsByTool = {};
for (const c of mcp.calls) {
  byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  charsByTool[c.tool] = (charsByTool[c.tool] ?? 0) + c.chars;
}
const report = {
  tasks: TITLES.length,
  spawned: tasks.length,
  completed: allDone(),
  adoptAvailableViaMcp,
  pollIntervalMs: POLL_MS,
  calls: { total: mcp.calls.length, byTool, fanoutPolls, rereads },
  resultChars: mcp.calls.reduce((n, c) => n + c.chars, 0),
  charsByTool,
  workerChars: { total: tasks.reduce((n, t) => n + t.workerChars, 0), perTask: tasks.map((t) => t.workerChars) },
  nudges: { count: nudges.length, chars: nudges.reduce((n, l) => n + l.length, 0), lines: nudges },
  wallMs: Date.now() - started,
  ...(res.isError ? { fanoutError: res.text.slice(0, 500) } : {}),
};
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`e2e parent done: ${JSON.stringify(report.calls)}`);
await mcp.close();
