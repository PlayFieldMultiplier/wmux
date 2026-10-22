// Pure helpers for scripts/e2e-first-run.mjs (the first-run end-to-end
// scenario). Kept apart from the driver so the rules that keep a run isolated
// and its teardown exact can be unit tested without launching anything:
// scripts/__tests__/e2eFirstRun.test.mjs.
//
// No shebang: a vitest test imports this file.
import path from 'node:path';
import { collectProcessTree, parseCimDate } from '../perf-process-tree.mjs';

/** Agent statuses that mean the agent is at rest at its prompt (shared/types AgentStatus). */
export const SETTLED_AGENT_STATUSES = new Set(['idle', 'waiting', 'complete', 'awaiting_input']);

/** Parse `--app <exe> [--keep] [--artifacts <dir>] [--suffix -e2e-x]`. */
export function parseRunArgs(argv) {
  const out = { app: null, keep: false, artifacts: null, suffix: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === '--app') out.app = next();
    else if (a === '--artifacts') out.artifacts = next();
    else if (a === '--suffix') out.suffix = next();
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** The env key holding PATH, in whatever case this environment spells it. */
function keyOf(env, name) {
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
}

/**
 * The environment the launched app (and the driver that launches it) runs
 * with: a sandbox home, the fake agents first on PATH.
 *
 *   - Windows: USERPROFILE/HOME/APPDATA/LOCALAPPDATA all point into the
 *     sandbox (the same isolation scripts/perf-bench.mjs uses), and
 *     HOMEDRIVE/HOMEPATH go, so nothing can rebuild the real profile path.
 *     PATHEXT keeps `.JS`, so the fake's `claude.js` is what wmux's resolver
 *     finds (it skips `.cmd`; src/main/claude/resolveClaudeExecutable.ts).
 *   - POSIX: HOME is the sandbox, and the XDG base dirs go so they derive
 *     from it.
 */
export function sandboxEnv(baseEnv, { home, fakeBin, platform = process.platform }) {
  const env = { ...baseEnv };
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const set = (name, value) => {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name && k !== name) delete env[k];
    env[name] = value;
  };
  const drop = (name) => {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
  };
  set('HOME', home);
  if (win) {
    set('USERPROFILE', home);
    set('APPDATA', p.join(home, 'AppData', 'Roaming'));
    set('LOCALAPPDATA', p.join(home, 'AppData', 'Local'));
    drop('HOMEDRIVE');
    drop('HOMEPATH');
    const extKey = keyOf(env, 'PATHEXT');
    const exts = String(env[extKey] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    if (!exts.some((e) => e.toUpperCase() === '.JS')) exts.push('.JS');
    set('PATHEXT', exts.join(';'));
  } else {
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) drop(k);
  }
  const pathKey = keyOf(env, 'PATH');
  const current = env[pathKey];
  const sep = win ? ';' : ':';
  env[pathKey] = current ? `${fakeBin}${sep}${current}` : fakeBin;
  return env;
}

/**
 * Variables only the app needs, passed through `control-wmux launch
 * --env-file` (its scrub would drop WMUX_* inherited from the driver):
 *   - WMUX_NO_PATH_REFRESH: on Windows wmux rebuilds a pane's PATH from the
 *     registry with registry entries FIRST, which would put the real agents
 *     ahead of the fakes (src/shared/windowsPathEnv.ts);
 *   - WMUX_NO_DIALOG: a stuck daemon fails the run instead of opening a modal;
 *   - FAKE_*: where the fakes log, and which hook settings Claude fires.
 * Never WMUX_MCP_REGISTER_EXTERNAL: MCP registration writes the agents'
 * configs under Electron's own idea of home (app.getPath('home')), which a
 * sandboxed HOME/USERPROFILE does not move. See seededClaudeJson.
 */
export function appEnvExtras({ fakeAgentLog, claudeHooksFile }) {
  return {
    WMUX_NO_PATH_REFRESH: '1',
    WMUX_NO_DIALOG: '1',
    FAKE_AGENT_LOG: fakeAgentLog,
    FAKE_CLAUDE_HOOKS: claudeHooksFile,
  };
}

/**
 * The sandbox's `~/.claude.json`, with wmux already registered as an MCP
 * server. A suffixed instance never writes agent configs (they are not
 * per-suffix, src/shared/mcpTargets.ts externalRegistrationSkipReason), so its
 * "Register" button cannot turn the wizard ready; the scenario starts from a
 * profile where that step is done. The wizard reads this file through the
 * sandboxed home (src/main/firstRun/ClaudeDetector.ts).
 */
export function seededClaudeJson(home, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return {
    mcpServers: { wmux: { command: 'node', args: [p.join(home, '.wmux', 'mcp', 'index.js')] } },
  };
}

/**
 * Lines in app.log that say wmux wrote an agent config or the MCP bundle
 * outside `sandboxHome`: the run escaped its sandbox.
 */
export function writesOutsideSandbox(appLog, sandboxHome) {
  const norm = (v) => v.replace(/\\/g, '/').toLowerCase();
  const home = norm(sandboxHome);
  const out = [];
  for (const line of String(appLog ?? '').split(/\r?\n/)) {
    const m = /\[McpRegistrar\] (?:.*: wrote \S+|MCP bundle synced to stable path|Registered wmux MCP) → (.+)$/.exec(line);
    if (m && !norm(m[1].trim()).startsWith(home)) out.push(line.trim());
  }
  return out;
}

/**
 * The files that put the fake agents on PATH, as `{ name, content, mode }`.
 *   - Windows: `<agent>.cmd` for shells (PowerShell and cmd pick it over the
 *     `.js`, PATHEXT order) and `<agent>.js` for wmux's resolver, which skips
 *     `.cmd` shims and runs a script under PATH `node`.
 *   - POSIX: an executable `<agent>` shell script.
 * Each one runs scripts/fixtures/fake-agents/<agent>.mjs by its full path,
 * which is also what wmux's process tracker needs to attribute the pane.
 */
export function fakeAgentShims({ node, fixturesDir, platform = process.platform }) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  for (const v of [node, fixturesDir]) {
    if (/["\r\n]/.test(v) || (win && v.includes('%'))) throw new Error(`path not usable in a shim: ${v}`);
  }
  const files = [];
  for (const agent of ['claude', 'codex']) {
    const script = p.join(fixturesDir, `${agent}.mjs`);
    if (win) {
      files.push({ name: `${agent}.cmd`, content: `@echo off\r\n"${node}" "${script}" %*\r\n` });
      const url = `file:///${script.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
      files.push({
        name: `${agent}.js`,
        content: `// Fake ${agent} for the wmux first-run e2e; see scripts/e2e-first-run.mjs.\nimport(${JSON.stringify(url)});\n`,
      });
    } else {
      files.push({ name: agent, content: `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`, mode: 0o755 });
    }
  }
  return files;
}

/**
 * Normalise a process listing to Win32_Process-shaped rows (what
 * perf-process-tree.mjs walks): { ProcessId, ParentProcessId, Name,
 * CreationDate (epoch ms), CommandLine }.
 *   - Windows: the parsed `Get-CimInstance Win32_Process | ConvertTo-Json`
 *     output (an object when there is one row).
 *   - POSIX: `ps -A -o pid=,ppid=,lstart=,args=` text.
 */
export function normalizeProcessRows(raw, platform = process.platform) {
  if (platform === 'win32') {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((r) => ({
      ProcessId: Number(r.ProcessId),
      ParentProcessId: Number(r.ParentProcessId),
      Name: String(r.Name ?? ''),
      CreationDate: parseCimDate(r.CreationDate),
      CommandLine: r.CommandLine == null ? null : String(r.CommandLine),
    }));
  }
  const rows = [];
  for (const line of String(raw ?? '').split('\n')) {
    // pid ppid Dow Mon DD HH:MM:SS YYYY args...
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const started = Date.parse(m[3].replace(/\s+/g, ' '));
    rows.push({
      ProcessId: Number(m[1]),
      ParentProcessId: Number(m[2]),
      Name: path.posix.basename(m[4].split(' ')[0] || ''),
      CreationDate: Number.isFinite(started) ? started : null,
      CommandLine: m[4],
    });
  }
  return rows;
}

/**
 * Every process this run launched: the app's tree plus the daemon's (the
 * daemon is spawned detached, and its panes hang off it). Rows are kept with
 * their creation time, which is what makes a later kill safe against pid
 * reuse.
 */
export function runProcessTree(rows, roots) {
  const { pids } = collectProcessTree(rows, roots.filter((p) => Number.isInteger(p) && p > 0));
  return rows.filter((r) => pids.has(r.ProcessId));
}

/** Merge tree snapshots taken at different moments, one row per pid+start. */
export function mergeTrees(...trees) {
  const seen = new Map();
  for (const tree of trees) for (const r of tree) seen.set(`${r.ProcessId}@${r.CreationDate}`, r);
  return [...seen.values()];
}

/**
 * The recorded processes still alive in `nowRows`: same pid AND same creation
 * time. A pid that came back with another start time is someone else's.
 */
export function survivors(recorded, nowRows) {
  const live = new Set(nowRows.map((r) => `${r.ProcessId}@${r.CreationDate}`));
  return recorded.filter((r) => r.CreationDate != null && live.has(`${r.ProcessId}@${r.CreationDate}`));
}

/** The one-line verdict the scenario prints last. */
export function verdictLine({ ok, step, reason, seconds }) {
  const took = Number.isFinite(seconds) ? ` (${seconds.toFixed(1)} s)` : '';
  return ok
    ? `first-run e2e: PASS${took}`
    : `first-run e2e: FAIL at ${step}: ${String(reason).replace(/\s+/g, ' ').trim()}${took}`;
}

/** Did the fake agent run inside a pane (a tty) and get the sample task's prompt? */
export function agentRanInPane(logText, agent = 'claude') {
  let started = false;
  let prompted = false;
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.agent !== agent) continue;
    if (e.event === 'start' && e.tty === true) started = true;
    if (e.event === 'prompt' && started) prompted = true;
  }
  return { started, prompted };
}
