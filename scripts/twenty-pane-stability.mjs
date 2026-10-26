/**
 * twenty-pane-stability.mjs: a soak benchmark that keeps 20 terminal panes
 * open for 30 minutes in an ISOLATED wmux instance and records, over time:
 *
 *   - focused-pane keystroke -> echo latency (CDP keyboard events, timed in
 *     the renderer from keydown to the echoed marker in pty.onData, plus the
 *     next animation frame), sampled every --sample-sec while focus moves
 *     between panes (pane.focus) and workspaces (Alt+ArrowDown);
 *   - an echo probe on EVERY pane each sample (a short marker written with
 *     electronAPI.pty.write, matched in pty.onData), so hidden and idle panes
 *     are measured too; markers that never come back are dropped inputs;
 *   - output stalls: a streaming pane whose output stops for --stall-ms;
 *   - memory: daemon RSS/heap/rings (daemon.ping includeMemory), Electron
 *     working sets per process type (perf.status includeMemory), and an OS
 *     process-tree sample every --tree-every samples.
 *
 * Mix: --streaming panes run a synthetic producer (TUI-style status repaint
 * plus colored log lines at --rate-kib KiB/s, backpressure-aware); the rest
 * are idle shells. Panes are spread over workspaces of --per-workspace panes,
 * so most of them are hidden, as in real use.
 *
 * WHY NOT A perf-bench.mjs SCENARIO: perf-bench.mjs runs its bench on import,
 * exits when the packaged Windows exe is missing, and is the CI perf gate.
 * This script reuses its importable helpers (perf-scenarios, perf-frame-sample,
 * perf-process-tree, perf-process-classify, lib/idle-memory) and copies the
 * instance lifecycle (isolated HOME + WMUX_DATA_SUFFIX, seeded plugin trust,
 * overlay dismissal, daemon shutdown), generalized to macOS and Linux.
 *
 * ISOLATION: a fresh temp HOME/USERPROFILE/APPDATA and a unique
 * WMUX_DATA_SUFFIX re-key every pipe, token, data dir and the single-instance
 * lock. The harness drives CDP only after the app itself logs
 * "CDP listening on port N" (ownership verified), only accepts renderer pages
 * under the launched app's directory, and kills only the pids it launched or
 * read from its own sandbox.
 *
 * HOW TO RUN (package first; PowerShell on Windows):
 *   npm run package
 *   node scripts/twenty-pane-stability.mjs
 *   node scripts/twenty-pane-stability.mjs --panes 4 --streaming 1 --per-workspace 2 --minutes 1
 *
 * Output: out/twenty-pane-stability/<stamp>/ (config.json, samples.ndjson
 * appended every sample, summary.json + summary.txt at the end or on Ctrl+C).
 * See docs/performance/twenty-panes.md.
 */
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { sampleRafDeltas } from './perf-frame-sample.mjs';
import { summarizeSamples } from './perf-scenarios.mjs';
import { collectProcessTree } from './perf-process-tree.mjs';
import { accumulateBreakdown, RAM_CATEGORIES } from './perf-process-classify.mjs';
import { parsePsRows, groupMemory } from './lib/idle-memory.mjs';
import {
  parseArgs, planLayout, pickStreaming, markerFor, stripTerminalControls,
  producerCommand, producerSource, shellPrepCommand, summarizeRun, renderSummary,
} from './lib/twenty-pane-stability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLATFORM = process.platform;
const USERNAME = os.userInfo().username || 'default';

let ARGS;
try {
  ARGS = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (ARGS.help) {
  console.log(`Usage: node scripts/twenty-pane-stability.mjs [flags]
  --minutes N            run length after setup (default 30)
  --panes N              terminal panes (default 20)
  --streaming N          panes running the synthetic producer (default 6)
  --per-workspace N      panes per workspace (default 5)
  --sample-sec N         seconds between samples (default 10)
  --keys N               focused-pane keystroke markers per sample (default 4)
  --workspace-switch-every N  switch workspace every N samples (default 3, 0 = never)
  --tree-every N         OS process-tree sample every N samples (default 3)
  --stall-ms N           output gap that counts as a stall (default 5000)
  --rate-kib N           producer output per streaming pane, KiB/s (default 16)
  --probe-timeout-ms N / --key-timeout-ms N   echo wait (default 3000)
  --app PATH             wmux executable (default: packaged build under out/)
  --out DIR              output directory (must not exist)
  --keep-app             leave the instance running at the end (debugging)`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultAppPath() {
  if (PLATFORM === 'win32') return path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
  if (PLATFORM === 'darwin') {
    const built = path.join(REPO_ROOT, 'out', `wmux-darwin-${process.arch}`, 'wmux.app', 'Contents', 'MacOS', 'wmux');
    return fs.existsSync(built) ? built : '/Applications/wmux.app/Contents/MacOS/wmux';
  }
  return path.join(REPO_ROOT, 'out', `wmux-linux-${process.arch}`, 'wmux');
}
const APP_EXE = path.resolve(ARGS.app ?? defaultAppPath());
if (!fs.existsSync(APP_EXE)) {
  console.error(`wmux executable not found at ${APP_EXE}. Run \`npm run package\` or pass --app.`);
  process.exit(2);
}
// Identity guard: only renderer pages served from the launched app's own
// directory (the .app bundle on macOS) are driven.
const APP_ROOT = PLATFORM === 'darwin' && APP_EXE.includes('.app/')
  ? APP_EXE.slice(0, APP_EXE.indexOf('.app/') + 4)
  : path.dirname(APP_EXE);
const APP_URL_PREFIX = pathToFileURL(APP_ROOT).href.toLowerCase();

// ---------------------------------------------------------------------------
// Pipe client (newline-delimited JSON-RPC), as in perf-bench.mjs
// ---------------------------------------------------------------------------

const BENCH_CLIENT_NAME = 'wmux-bench';
// pane.list / pane.focus / perf.status -> pane.read; pane.split -> pane.create;
// input.send -> terminal.send; mcp.claimWorkspace -> workspace.claim;
// workspace.current -> workspace.read. daemon.* goes to the daemon pipe.
const BENCH_CAPABILITIES = ['pane.read', 'pane.create', 'terminal.send', 'workspace.claim', 'workspace.read'];

class PipeClient {
  constructor(pipeName, token) {
    this.pipeName = pipeName;
    this.token = token;
    this.sock = null;
    this.buf = '';
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipeName);
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => { settled = true; this.sock = sock; resolve(); });
      sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
        this.pending.clear();
      });
    });
  }
  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? msg);
    }
  }
  call(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token, clientName: BENCH_CLIENT_NAME, clientVersion: '0.0.0-bench' }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch { /* noop */ } }
}

function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (val) => { try { sock.destroy(); } catch { /* noop */ } resolve(val); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitFor(label, fn, timeoutMs, intervalMs = 150) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    if (Date.now() - start >= timeoutMs) throw new Error(`timeout waiting for ${label} after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}
/** Retry a call that the production per-socket rate limit refused. Pacing, not a fix. */
async function callPaced(client, method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.call(method, params);
      const err = res && typeof res === 'object' ? res.error : null;
      if (!err) return res;
      throw new Error(String(err));
    } catch (e) {
      if (!/rate limited|RESOURCE_EXHAUSTED/i.test(e.message) || attempt >= 6) throw e;
      await sleep(1200);
    }
  }
}

// ---------------------------------------------------------------------------
// Isolated instance
// ---------------------------------------------------------------------------

function powershellExe() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
/** Run a PowerShell script via -EncodedCommand (no quoting through argv). */
function runPowerShell(script, timeoutMs = 15000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
  });
}
function runPs(args) {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function makeInstance() {
  // macOS/Linux session sockets live at <home>/.wmux<suffix>/session-<uuid>.sock
  // and must fit sun_path (104 bytes on macOS); macOS's per-user tmpdir is too
  // long for that, so POSIX sandboxes go under /tmp when needed.
  const tmpRoot = PLATFORM === 'win32' || os.tmpdir().length <= 20 ? os.tmpdir() : '/tmp';
  const home = fs.mkdtempSync(path.join(tmpRoot, 'wsk-'));
  const suffix = `-s${process.pid.toString(36)}`;
  const env = { ...process.env };
  // Never inherit the identity of the wmux pane this script may run in.
  for (const key of Object.keys(env)) {
    if (key.startsWith('WMUX_') || key === 'ZDOTDIR' || key === 'XDG_CONFIG_HOME' || key === 'XDG_DATA_HOME') delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    WMUX_DATA_SUFFIX: suffix,
    WMUX_NO_DIALOG: '1',
  });
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });

  const wmuxDir = path.join(home, `.wmux${suffix}`);
  fs.mkdirSync(wmuxDir, { recursive: true });
  // Skip the hooks prompt and pin the production permission gate, with a
  // trusted row for this client (see perf-bench.mjs seedBenchTrust).
  fs.writeFileSync(path.join(wmuxDir, 'hooks-prompt.json'), JSON.stringify({ suppressed: true }), 'utf8');
  const now = Date.now();
  fs.writeFileSync(path.join(wmuxDir, 'plugin-trust.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      [BENCH_CLIENT_NAME]: {
        name: BENCH_CLIENT_NAME, version: '0.0.0-bench', status: 'trusted',
        declaredCapabilities: BENCH_CAPABILITIES,
        rationale: 'twenty-pane-stability.mjs sandbox instance',
        firstSeen: now, lastSeen: now,
      },
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify({ mcp: { mode: 'enforce' } }, null, 2), 'utf8');

  // The first-run wizard would swallow focus; seed its marker in userData.
  // Where Electron puts appData depends on the platform (and on macOS it may
  // not follow HOME), so seed every candidate this run creates, verify against
  // the userData path the app logs, and remove the ones we created at the end.
  const candidates = PLATFORM === 'win32'
    ? [path.join(env.APPDATA, `wmux${suffix}`)]
    : PLATFORM === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', `wmux${suffix}`),
        path.join(os.homedir(), 'Library', 'Application Support', `wmux${suffix}`)]
      : [path.join(home, '.config', `wmux${suffix}`)];
  const createdUserData = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) createdUserData.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.first-run'), new Date().toISOString(), 'utf8');
  }

  return {
    home, suffix, env, wmuxDir, userDataCandidates: candidates, createdUserData,
    mainPipe: PLATFORM === 'win32' ? `\\\\.\\pipe\\wmux${suffix}-${USERNAME}` : path.join(home, `.wmux${suffix}.sock`),
    mainTokenPath: path.join(home, `.wmux${suffix}-auth-token`),
    proc: null, browser: null, page: null, cdpPort: null, userDataLogged: null, logTail: [],
  };
}

function readDaemonPid(inst) {
  try {
    const pid = Number(fs.readFileSync(path.join(inst.wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function readDaemonPipeName(inst) {
  try {
    const name = fs.readFileSync(path.join(inst.wmuxDir, 'daemon-pipe'), 'utf8').trim();
    if (name) return name;
  } catch { /* default below */ }
  return PLATFORM === 'win32' ? `\\\\.\\pipe\\wmux-daemon${inst.suffix}-${USERNAME}` : path.join(inst.wmuxDir, 'daemon.sock');
}
function readDaemonToken(inst) {
  for (const p of [path.join(inst.wmuxDir, 'daemon-auth-token'), path.join(inst.home, '.wmux', 'daemon-auth-token')]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}

/** Spawn the app and resolve with the CDP port once the app reports it verified. */
function spawnInstance(inst) {
  // macOS: with a sandbox HOME there is no login keychain, and Chromium's
  // Safe Storage key request blocks the main process behind a keychain dialog
  // before `ready`. The mock keychain keeps the run unattended and off the
  // user's real keychain.
  const args = PLATFORM === 'darwin' ? ['--use-mock-keychain'] : [];
  inst.proc = spawn(APP_EXE, args, { cwd: inst.home, env: inst.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let buf = '';
  return new Promise((resolve, reject) => {
    let requested = null;
    const timer = setTimeout(() => reject(new Error(requested
      ? `CDP port ${requested} was requested but never verified ("CDP listening") within 60 s`
      : 'no CDP line from the app within 60 s')), 60000);
    const onChunk = (b) => {
      buf += b.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        inst.logTail.push(line);
        if (inst.logTail.length > 60) inst.logTail.shift();
        const ud = /WMUX_DATA_SUFFIX="[^"]*" → userData="([^"]+)"/.exec(line);
        if (ud) inst.userDataLogged = ud[1];
        const req = /CDP requested on port (\d+)/.exec(line);
        if (req) requested = Number(req[1]);
        // "listening" is logged after the app verified the port is its own
        // (#1331 ownership probe); "enabled" is the pre-#1331 wording.
        const ok = /CDP (?:listening|enabled) on port (\d+)/.exec(line);
        if (ok && inst.cdpPort === null) {
          inst.cdpPort = Number(ok[1]);
          clearTimeout(timer);
          resolve(inst.cdpPort);
        }
      }
    };
    inst.proc.stdout.on('data', onChunk);
    inst.proc.stderr.on('data', onChunk);
    inst.proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`app exited (code ${code}) before CDP was ready`)); });
  });
}

async function findRendererPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      try {
        if (!p.url().toLowerCase().startsWith(APP_URL_PREFIX)) continue;
        if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p;
      } catch { /* navigating */ }
    }
  }
  return null;
}

// First-boot overlays (onboarding tour, auto-update prompt) swallow clicks
// and focus; same handling as perf-bench.mjs dismissOverlays.
async function dismissOverlays(page) {
  let clean = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const state = await page.evaluate(() => ({
        tour: !!document.querySelector('.onboarding-overlay'),
        autoUpdate: [...document.querySelectorAll('div.fixed.inset-0')].some((d) => d.className.includes('z-[60]')),
      }));
      if (!state.tour && !state.autoUpdate) {
        if (++clean >= 2) return;
        await sleep(500);
        continue;
      }
      clean = 0;
      if (state.tour) await page.keyboard.press('Escape');
      else {
        await page.evaluate(() => {
          [...document.querySelectorAll('div.fixed.inset-0')].find((d) => d.className.includes('z-[60]'))?.querySelector('button')?.click();
        });
      }
      await sleep(400);
    } catch { await sleep(400); }
  }
  console.error('[setup] warning: overlays still present after dismissal attempts');
}

// Renderer instrumentation. One pty.onData subscriber sees every pane, hidden
// workspaces included (the output scheduler queues downstream of it).
//   - per pty: last data time, byte count, and gaps >= stallMs (stalls);
//   - pending markers: matched in the control-stripped tail of the pane's
//     output; keyboard markers are timed from the keydown of their last key,
//     probes from the pty.write call; keyboard results also get the next rAF.
function hookSource(stallMs) {
  return `(() => {
  if (window.__wmuxSoak) return;
  const strip = ${stripTerminalControls.toString()};
  const H = { gapMs: ${Number(stallMs)}, last: {}, bytes: {}, tails: {}, gaps: [], pending: new Map(), results: [], late: [], key: null, ready: false };
  window.__wmuxSoak = H;
  window.addEventListener('keydown', (e) => {
    const k = H.key;
    if (k && k.armed && k.t0 === null && e.key === k.last) {
      k.t0 = performance.now();
      const p = H.pending.get(k.marker);
      if (p) p.t0 = k.t0;
    }
  }, { capture: true });
  const onData = (id, data) => {
    const now = performance.now();
    const prev = H.last[id];
    if (prev !== undefined && now - prev >= H.gapMs) H.gaps.push({ ptyId: id, gapMs: Math.round(now - prev), at: Date.now() });
    H.last[id] = now;
    H.bytes[id] = (H.bytes[id] || 0) + (data ? data.length : 0);
    if (H.pending.size === 0 || typeof data !== 'string') return;
    let tail = (H.tails[id] || '') + data;
    if (tail.length > 2048) tail = tail.slice(-2048);
    H.tails[id] = tail;
    const text = strip(tail);
    for (const [marker, p] of H.pending) {
      if (p.t0 === null || text.indexOf(marker) === -1) continue;
      H.pending.delete(marker);
      H.tails[id] = '';
      const rec = { marker, kind: p.kind, ptyId: id, expected: p.expected, echoMs: now - p.t0 };
      // An echo after the harness gave up is late, not a sample.
      const sink = p.timedOut ? H.late : H.results;
      if (p.kind === 'key') requestAnimationFrame(() => { rec.frameMs = performance.now() - p.t0; sink.push(rec); });
      else sink.push(rec);
      break;
    }
  };
  const tryHook = () => {
    const api = window.electronAPI;
    if (!api || !api.pty || typeof api.pty.onData !== 'function') { setTimeout(tryHook, 5); return; }
    api.pty.onData(onData);
    H.ready = true;
  };
  tryHook();
})();`;
}

async function bootInstance(inst) {
  const port = await spawnInstance(inst);
  console.log(`[setup] app pid ${inst.proc.pid}, CDP port ${port} (verified by the app)`);
  inst.browser = await waitFor(`CDP connect :${port}`, async () => {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
  }, 30000);
  const hook = hookSource(ARGS.stallMs);
  for (const ctx of inst.browser.contexts()) {
    try { await ctx.addInitScript(hook); } catch { /* evaluated below */ }
  }
  inst.page = await waitFor('renderer page (.xterm)', () => findRendererPage(inst.browser), 90000);
  await inst.page.evaluate(hook);
  await waitFor('renderer hook', () => inst.page.evaluate(() => window.__wmuxSoak?.ready === true), 15000);
  if (inst.userDataLogged && !inst.userDataCandidates.some((d) => path.resolve(d) === path.resolve(inst.userDataLogged))) {
    console.error('[setup] warning: the app chose a userData dir this harness did not seed; a first-run wizard may take focus');
  }
  await waitFor('main pipe', () => pipeAlive(inst.mainPipe), 30000);
  const token = await waitFor('main auth token', () => {
    try { return fs.readFileSync(inst.mainTokenPath, 'utf8').trim() || null; } catch { return null; }
  }, 15000);
  inst.main = new PipeClient(inst.mainPipe, token);
  await inst.main.connect();
  await dismissOverlays(inst.page);
}

async function daemonClient(inst) {
  if (inst.daemon && inst.daemon.sock && !inst.daemon.sock.destroyed) return inst.daemon;
  const token = readDaemonToken(inst);
  if (!token) return null;
  const c = new PipeClient(readDaemonPipeName(inst), token);
  await c.connect();
  inst.daemon = c;
  return c;
}

async function pidLooksLikeWmuxDaemon(pid) {
  try {
    if (PLATFORM === 'win32') {
      const out = await runPowerShell(`Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`, 5000);
      if (!out.trim()) return false;
      const p = JSON.parse(out);
      const name = String(p.Name ?? '').toLowerCase();
      return (name.includes('wmux') || name.includes('node')) && String(p.CommandLine ?? '').toLowerCase().includes('daemon');
    }
    const out = await runPs(['-p', String(pid), '-o', 'command=']);
    return /daemon/i.test(out);
  } catch { return true; } // lookup failed: the pid came from our own sandbox's pid file
}

async function shutdownInstance(inst) {
  if (inst.shuttingDown) return;
  inst.shuttingDown = true;
  try { await inst.browser?.close(); } catch { /* noop */ }
  inst.main?.close();
  const daemonPid = readDaemonPid(inst);
  try {
    const dc = await daemonClient(inst);
    if (dc) await dc.call('daemon.shutdown', {}, 5000).catch(() => { /* ack may race the exit */ });
  } catch { /* pid fallback below */ }
  inst.daemon?.close();
  const deadline = Date.now() + 8000;
  while (daemonPid && pidAlive(daemonPid) && Date.now() < deadline) await sleep(150);
  if (daemonPid && pidAlive(daemonPid) && await pidLooksLikeWmuxDaemon(daemonPid)) {
    try { process.kill(daemonPid); } catch { /* noop */ }
    await sleep(300);
    if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* noop */ } }
  }
  if (inst.proc && inst.proc.exitCode === null) {
    try { inst.proc.kill(); } catch { /* noop */ }
    const exitDeadline = Date.now() + 5000;
    while (inst.proc.exitCode === null && Date.now() < exitDeadline) await sleep(100);
    if (inst.proc.exitCode === null) { try { inst.proc.kill('SIGKILL'); } catch { /* noop */ } }
  }
  await sleep(500);
  for (const dir of [inst.home, ...inst.createdUserData]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Setup: workspaces, panes, shells, producers
// ---------------------------------------------------------------------------

async function listPanes(inst, workspaceId) {
  const res = await inst.main.call('pane.list', { workspaceId });
  const panes = Array.isArray(res?.panes) ? res.panes : Array.isArray(res) ? res : [];
  return panes.map((p) => ({ id: p.id, ptyId: (p.surfacePtyIds ?? [])[0] ?? null, deferred: p.deferred === true, active: p.active === true }));
}

/** Split the largest pane of a workspace until it holds `count` panes (a grid, not a spiral). */
async function fillWorkspace(inst, workspaceId, count) {
  let panes = await listPanes(inst, workspaceId);
  const area = new Map(panes.map((p) => [p.id, { area: 1, depth: 0 }]));
  while (panes.length < count) {
    const target = panes.reduce((a, b) => ((area.get(b.id)?.area ?? 0) > (area.get(a.id)?.area ?? 0) ? b : a));
    const meta = area.get(target.id) ?? { area: 1, depth: 0 };
    await callPaced(inst.main, 'pane.focus', { id: target.id });
    await callPaced(inst.main, 'pane.split', { workspaceId, direction: meta.depth % 2 === 0 ? 'horizontal' : 'vertical' });
    const before = panes.length;
    panes = await waitFor(`pane ${before + 1} in workspace`, async () => {
      const next = await listPanes(inst, workspaceId);
      return next.length > before ? next : null;
    }, 20000, 250);
    for (const p of panes) if (!area.has(p.id)) area.set(p.id, { area: meta.area / 2, depth: meta.depth + 1 });
    area.set(target.id, { area: meta.area / 2, depth: meta.depth + 1 });
    await sleep(300);
  }
}

async function currentWorkspaceId(inst) {
  const cur = await inst.main.call('workspace.current', {});
  return cur?.id ?? null;
}

async function setup(inst) {
  const layout = planLayout(ARGS.panes, ARGS.perWorkspace);
  const workspaceIds = [await currentWorkspaceId(inst)];
  if (!workspaceIds[0]) throw new Error('no active workspace after boot');
  for (let w = 1; w < layout.length; w++) {
    const res = await callPaced(inst.main, 'mcp.claimWorkspace', { name: `soak-${w + 1}` });
    if (typeof res?.workspaceId !== 'string') throw new Error(`mcp.claimWorkspace returned no workspaceId: ${JSON.stringify(res)}`);
    workspaceIds.push(res.workspaceId);
    await sleep(300);
  }
  for (let w = 0; w < layout.length; w++) {
    await fillWorkspace(inst, workspaceIds[w], layout[w]);
    console.log(`[setup] workspace ${w + 1}/${layout.length}: ${layout[w]} panes`);
  }
  // Show every workspace once with the real shortcut, so no pane stays
  // deferred (#2398) and the switch path is proven before the run.
  for (let w = 0; w < layout.length; w++) {
    await inst.page.keyboard.press('Alt+ArrowDown');
    await sleep(1500);
  }
  const panes = [];
  await waitFor('every pane has a started terminal', async () => {
    panes.length = 0;
    for (let w = 0; w < layout.length; w++) {
      const rows = await listPanes(inst, workspaceIds[w]);
      if (rows.length !== layout[w] || rows.some((r) => !r.ptyId || r.deferred)) return false;
      rows.forEach((r, i) => panes.push({ workspaceIndex: w, workspaceId: workspaceIds[w], indexInWorkspace: i, paneId: r.id, ptyId: r.ptyId }));
    }
    return true;
  }, 60000, 1000);
  panes.forEach((p, i) => { p.index = i; });
  const streaming = pickStreaming(panes, ARGS.streaming);
  panes.forEach((p, i) => { p.cls = streaming.has(i) ? 'streaming' : 'idle'; });

  // Short prompt everywhere so markers never wrap; then start the producers.
  for (const p of panes) {
    await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: shellPrepCommand(PLATFORM), submit: true, raw: true });
    await sleep(150);
  }
  await sleep(2000);
  const producerPath = path.join(inst.home, 'soak-producer.cjs');
  fs.writeFileSync(producerPath, producerSource(), 'utf8');
  const seconds = Math.ceil(ARGS.minutes * 60 + 600);
  for (const p of panes.filter((x) => x.cls === 'streaming')) {
    const cmd = producerCommand(PLATFORM, process.execPath, producerPath, [p.index, ARGS.rateKiB, seconds]);
    await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: cmd, submit: true, raw: true });
    await sleep(250);
  }
  // Cold node starts under PowerShell on a loaded machine can take a while:
  // wait until every streaming pane shows a producer status row, then check
  // that its output keeps growing.
  const streamingIds = panes.filter((p) => p.cls === 'streaming').map((p) => p.ptyId);
  const flowing = async () => {
    const before = await inst.page.evaluate(() => ({ ...window.__wmuxSoak.bytes }));
    await sleep(1500);
    const after = await inst.page.evaluate(() => ({ ...window.__wmuxSoak.bytes }));
    return streamingIds.filter((id) => !((after[id] ?? 0) > (before[id] ?? 0) + 1024));
  };
  try {
    await waitFor('streaming panes producing output', async () => (await flowing()).length === 0, 45000, 500);
  } catch {
    throw new Error(`${(await flowing()).length} streaming pane(s) produce no output after 45 s; the producer did not start`);
  }
  await inst.page.evaluate(() => { window.__wmuxSoak.gaps.length = 0; });
  return { panes, workspaceIds, layout };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

let markerSeq = 0;

async function collectResults(page) {
  return page.evaluate(() => window.__wmuxSoak.results.splice(0));
}

/** Type one marker into whatever has keyboard focus; time the last key. */
async function keyboardMarker(page, paneIndex, expectedPtyId) {
  const marker = markerFor(paneIndex, ++markerSeq);
  await page.evaluate(({ marker, expected }) => {
    const H = window.__wmuxSoak;
    H.tails = {};
    H.pending.set(marker, { kind: 'key', expected, t0: null });
    H.key = { marker, last: marker[marker.length - 1], armed: false, t0: null };
  }, { marker, expected: expectedPtyId });
  await page.keyboard.type(marker.slice(0, -1), { delay: 15 });
  await page.evaluate(() => { window.__wmuxSoak.key.armed = true; });
  await page.keyboard.press(marker[marker.length - 1]);
  let rec = null;
  const deadline = Date.now() + ARGS.keyTimeoutMs;
  while (!rec && Date.now() < deadline) {
    await sleep(20);
    const got = await collectResults(page);
    rec = got.find((r) => r.marker === marker) ?? null;
  }
  if (!rec) await page.evaluate((m) => { const p = window.__wmuxSoak.pending.get(m); if (p) p.timedOut = true; }, marker);
  for (let i = 0; i < marker.length; i++) await page.keyboard.press('Backspace');
  await sleep(150);
  return { marker, rec };
}

/** Write a marker to every pane, wait for the echoes, then erase them. */
async function probeAll(page, panes) {
  const batch = panes.map((p) => ({ marker: markerFor(p.index, ++markerSeq), ptyId: p.ptyId }));
  await page.evaluate(async (items) => {
    const H = window.__wmuxSoak;
    H.tails = {};
    for (const b of items) {
      H.pending.set(b.marker, { kind: 'probe', expected: b.ptyId, t0: performance.now() });
      window.electronAPI.pty.write(b.ptyId, b.marker);
      await new Promise((r) => setTimeout(r, 20));
    }
  }, batch);
  const got = new Map();
  const deadline = Date.now() + ARGS.probeTimeoutMs;
  while (got.size < batch.length && Date.now() < deadline) {
    await sleep(50);
    for (const r of await collectResults(page)) got.set(r.marker, r);
  }
  const missing = batch.filter((b) => !got.has(b.marker)).map((b) => b.marker);
  await page.evaluate(async ({ items, missing }) => {
    const H = window.__wmuxSoak;
    for (const m of missing) { const p = H.pending.get(m); if (p) p.timedOut = true; }
    for (const b of items) {
      window.electronAPI.pty.write(b.ptyId, '\x7f'.repeat(b.marker.length));
      await new Promise((r) => setTimeout(r, 20));
    }
  }, { items: batch, missing });
  return batch.map((b, i) => ({ ...b, pane: panes[i], rec: got.get(b.marker) ?? null }));
}

const MEM_TYPES = { Browser: 'mainBytes', Tab: 'rendererBytes', GPU: 'gpuBytes' };

async function sampleMemory(inst, withTree) {
  const mem = {};
  try {
    const perf = await inst.main.call('perf.status', { includeMemory: true });
    const procs = perf?.memory?.processes;
    if (Array.isArray(procs)) {
      mem.electronBytes = procs.reduce((a, p) => a + (p.workingSetBytes || 0), 0);
      for (const p of procs) {
        const key = MEM_TYPES[p.type];
        if (key) mem[key] = (mem[key] ?? 0) + (p.workingSetBytes || 0);
      }
      mem.electronProcesses = procs.length;
    }
  } catch (e) { mem.electronError = e.message; }
  let daemonPid = readDaemonPid(inst);
  try {
    const dc = await daemonClient(inst);
    const pong = dc ? await dc.call('daemon.ping', { includeMemory: true }, 5000) : null;
    if (pong && Number.isFinite(pong.eventLoopLagMs)) mem.daemonEventLoopLagMs = pong.eventLoopLagMs;
    const d = pong?.memory;
    if (d) {
      daemonPid = d.pid ?? daemonPid;
      mem.daemonRssBytes = d.rssBytes;
      mem.daemonHeapUsedBytes = d.heapUsedBytes;
      const sum = (k) => d.sessions.reduce((a, s) => a + (s[k] || 0), 0);
      mem.ringAllocatedBytes = sum('ringAllocatedBytes');
      mem.ringStoredBytes = sum('ringStoredBytes');
      mem.socketQueuedBytes = sum('socketQueuedBytes');
      mem.resyncQueuedBytes = sum('resyncQueuedBytes');
      mem.sessionStates = d.sessions.reduce((a, s) => { a[s.state] = (a[s.state] ?? 0) + 1; return a; }, {});
      if (d.hibernation) mem.hibernatedSessions = d.hibernation.sessions;
    }
  } catch (e) {
    mem.daemonError = e.message;
    inst.daemon?.close();
    inst.daemon = null;
  }
  if (withTree) {
    try { Object.assign(mem, await sampleProcessTree(inst.proc.pid, daemonPid)); } catch (e) { mem.treeError = e.message; }
  }
  return mem;
}

/** OS process-tree working set / RSS of the app and the daemon, incl. shells and producers. */
async function sampleProcessTree(appPid, daemonPid) {
  if (PLATFORM === 'win32') {
    const out = await runPowerShell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize,PageFileUsage | ConvertTo-Json -Compress', 30000);
    const rows = JSON.parse(out);
    const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
    const { pids, rejectedEdgeCount } = collectProcessTree(rows, daemonPid ? [appPid, daemonPid] : [appPid]);
    const treeRows = [...pids].map((pid) => byPid.get(pid)).filter(Boolean).map((p) => ({
      pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine,
      workingSetBytes: Number(p.WorkingSetSize) || 0, commitBytes: (Number(p.PageFileUsage) || 0) * 1024,
    }));
    const breakdown = accumulateBreakdown(treeRows, { mainPid: appPid, daemonPid });
    return {
      treeBytes: treeRows.reduce((a, r) => a + r.workingSetBytes, 0),
      treeProcesses: treeRows.length,
      treeRejectedEdges: rejectedEdgeCount,
      treeBreakdown: Object.fromEntries(RAM_CATEGORIES.map((c) => [c, { bytes: breakdown[c].workingSetBytes, processes: breakdown[c].processCount }])),
    };
  }
  const rows = parsePsRows(await runPs(['-axo', 'pid=,ppid=,rss=,comm=']));
  const g = groupMemory(rows, appPid, daemonPid ?? -1, -1);
  return {
    treeBytes: g.app.rssBytes + g.daemon.rssBytes + g.workloads.rssBytes,
    treeProcesses: g.app.processes + g.daemon.processes + g.workloads.processes,
    treeBreakdown: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { bytes: v.rssBytes, processes: v.processes }])),
  };
}

async function focusActiveTerminal(page) {
  const focused = () => page.evaluate(() => !!document.activeElement?.classList?.contains('xterm-helper-textarea'));
  if (await focused()) return true;
  // The active pane did not take keyboard focus by itself: click the largest
  // visible terminal, as a user would. Counted as a focus miss either way.
  const box = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('.xterm-screen')) {
      const r = el.getBoundingClientRect();
      if (r.width >= 60 && r.height >= 40 && (!best || r.width * r.height > best.w * best.h)) best = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return best;
  });
  if (box) {
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(250);
  }
  return false;
}

async function runSample(inst, ctx, tick, t0) {
  const { page } = inst;
  const tSec = (Date.now() - t0) / 1000;
  const sample = { tick, tSec: Math.round(tSec * 10) / 10, focus: {}, keyboard: [], probes: [] };

  // 1. Move focus: a workspace switch every N samples, a pane switch always.
  const switchWs = ARGS.workspaceSwitchEvery > 0 && tick > 0 && tick % ARGS.workspaceSwitchEvery === 0 && ctx.layout.length > 1;
  if (switchWs) {
    await page.keyboard.press('Alt+ArrowDown');
    await sleep(500);
  }
  const wsId = await currentWorkspaceId(inst).catch(() => null);
  const inWs = ctx.panes.filter((p) => p.workspaceId === wsId);
  let target = null;
  if (inWs.length) {
    ctx.rotation[wsId] = ((ctx.rotation[wsId] ?? -1) + 1) % inWs.length;
    target = inWs[ctx.rotation[wsId]];
    await inst.main.call('pane.focus', { id: target.paneId }).catch(() => { /* recorded via focus miss */ });
    await sleep(250);
  }
  sample.focus = { workspaceSwitch: switchWs, workspaceIndex: target?.workspaceIndex ?? null, paneIndex: target?.index ?? null };
  sample.focus.focused = await focusActiveTerminal(page);
  await dismissOverlays(page);

  // 2. Focused keystrokes.
  for (let k = 0; k < ARGS.keysPerSample; k++) {
    const { rec } = await keyboardMarker(page, target?.index ?? 99, target?.ptyId ?? null);
    sample.keyboard.push({
      phase: k === 0 ? 'afterSwitch' : 'steady',
      echoMs: rec ? Math.round(rec.echoMs * 1000) / 1000 : null,
      frameMs: rec && Number.isFinite(rec.frameMs) ? Math.round(rec.frameMs * 1000) / 1000 : null,
      ptyId: rec?.ptyId ?? null,
      wrongPane: !!(rec && target && rec.ptyId !== target.ptyId),
    });
  }

  // 3. Probe every pane.
  for (const r of await probeAll(page, ctx.panes)) {
    sample.probes.push({
      ptyId: r.ptyId, paneIndex: r.pane.index, cls: r.pane.cls,
      echoMs: r.rec && r.rec.ptyId === r.ptyId ? Math.round(r.rec.echoMs * 1000) / 1000 : null,
    });
  }

  // 4. Late echoes of earlier timeouts, stalls, silence, frame cadence.
  const state = await page.evaluate(() => {
    const H = window.__wmuxSoak;
    const now = performance.now();
    const late = H.late.splice(0);
    for (const [m, p] of H.pending) if (p.timedOut && p.t0 !== null && now - p.t0 > 60000) H.pending.delete(m);
    const sinceLast = {};
    for (const id of Object.keys(H.last)) sinceLast[id] = Math.round(now - H.last[id]);
    return { late, gaps: H.gaps.splice(0), sinceLast, bytes: { ...H.bytes } };
  });
  sample.late = state.late.map((r) => ({ kind: r.kind, ptyId: r.ptyId, lateMs: Math.round(r.echoMs) }));
  const clsOf = new Map(ctx.panes.map((p) => [p.ptyId, p.cls]));
  sample.stalls = state.gaps.filter((g) => clsOf.get(g.ptyId) === 'streaming')
    .map((g) => ({ ptyId: g.ptyId, cls: 'streaming', gapMs: g.gapMs, atSec: Math.round((g.at - t0) / 100) / 10 }));
  sample.silent = ctx.panes.filter((p) => p.cls === 'streaming' && (state.sinceLast[p.ptyId] ?? Infinity) > ARGS.stallMs)
    .map((p) => ({ ptyId: p.ptyId, cls: p.cls, silentMs: state.sinceLast[p.ptyId] ?? null }));
  sample.outputBytes = ctx.panes.reduce((a, p) => a + (state.bytes[p.ptyId] ?? 0), 0);
  const raf = summarizeSamples(await sampleRafDeltas(page, 20));
  sample.raf = { p50: raf.p50, p95: raf.p95, throttled: (raf.p50 ?? 999) > 50 };

  // 5. Memory.
  sample.memory = await sampleMemory(inst, ARGS.treeEvery > 0 && tick % ARGS.treeEvery === 0);
  return sample;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

let inst = null;
let outDir = null;
let samples = [];
let finished = false;

function writeSummary(reason) {
  if (!outDir) return null;
  const summary = { reason, ...summarizeRun(samples, { stallMs: ARGS.stallMs }) };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const text = renderSummary(summary);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), text + '\n');
  return text;
}

async function finish(reason, code) {
  if (finished) return;
  finished = true;
  const text = writeSummary(reason);
  if (text) console.log(`\n${text}\n\nresults: ${outDir}`);
  if (inst && !ARGS.keepApp) await shutdownInstance(inst);
  process.exit(code);
}

process.on('SIGINT', () => { void finish('interrupted', 130); });

async function main() {
  outDir = path.resolve(ARGS.out ?? path.join(REPO_ROOT, 'out', 'twenty-pane-stability', stamp()));
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.mkdirSync(outDir); // fails if it exists: results are never overwritten
  const samplesPath = path.join(outDir, 'samples.ndjson');

  inst = makeInstance();
  console.log(`[setup] isolated instance, data suffix ${inst.suffix}`);
  await bootInstance(inst);
  const ctx = await setup(inst);
  ctx.rotation = {};
  const config = {
    platform: PLATFORM, arch: process.arch, osRelease: os.release(), node: process.version,
    cpus: os.cpus().length, totalMemBytes: os.totalmem(),
    startedAt: new Date().toISOString(),
    args: { ...ARGS, app: path.basename(APP_EXE), out: undefined },
    layout: ctx.layout,
    panes: ctx.panes.map((p) => ({ index: p.index, workspaceIndex: p.workspaceIndex, ptyId: p.ptyId, cls: p.cls })),
  };
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`[run] ${ctx.panes.length} panes (${ctx.panes.filter((p) => p.cls === 'streaming').length} streaming) for ${ARGS.minutes} min, a sample every ${ARGS.sampleSec} s`);

  const t0 = Date.now();
  const endAt = t0 + ARGS.minutes * 60000;
  for (let tick = 0; Date.now() < endAt; tick++) {
    const started = Date.now();
    if (inst.proc.exitCode !== null) throw new Error(`the app exited (code ${inst.proc.exitCode}) during the run`);
    const sample = await runSample(inst, ctx, tick, t0);
    samples.push(sample);
    fs.appendFileSync(samplesPath, JSON.stringify(sample) + '\n');
    const kb = sample.keyboard.filter((k) => k.echoMs !== null).map((k) => k.echoMs);
    const pr = sample.probes.filter((p) => p.echoMs !== null).map((p) => p.echoMs);
    console.log(`[t+${Math.round(sample.tSec)}s] key max ${kb.length ? Math.max(...kb).toFixed(1) : '-'} ms (${sample.keyboard.length - kb.length} lost), ` +
      `probe max ${pr.length ? Math.max(...pr).toFixed(1) : '-'} ms (${sample.probes.length - pr.length} lost), stalls ${sample.stalls.length}, ` +
      `daemon ${((sample.memory.daemonRssBytes ?? NaN) / 1048576).toFixed(0)} MiB, electron ${((sample.memory.electronBytes ?? NaN) / 1048576).toFixed(0)} MiB` +
      `${sample.raf.throttled ? ', window throttled' : ''}`);
    const next = started + ARGS.sampleSec * 1000;
    if (next >= endAt) break;
    await sleep(Math.max(0, next - Date.now()));
  }
  await finish('completed', 0);
}

main().catch(async (e) => {
  console.error(`[fatal] ${e.stack || e.message}`);
  if (inst?.logTail?.length) console.error(`[fatal] last app output lines:\n${inst.logTail.slice(-15).join('\n')}`);
  await finish(`failed: ${e.message}`, 1);
});
