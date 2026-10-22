// Pure helpers for scripts/e2e-first-run.mjs (the first-run end-to-end
// scenario). Kept apart from the driver so the rules that keep a run isolated
// and its teardown exact can be unit tested without launching anything:
// scripts/__tests__/e2eFirstRun.test.mjs.
//
// No shebang: a vitest test imports this file.
import os from 'node:os';
import path from 'node:path';
import { collectProcessTree, parseCimDate } from '../perf-process-tree.mjs';
import { parseLstart, suffixRefusal } from './control-wmux-lib.mjs';

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
    else if (a === '--suffix') {
      // The suffix becomes part of paths the run creates and deletes.
      out.suffix = next();
      const refusal = suffixRefusal(out.suffix);
      if (refusal) throw new Error(`--suffix: ${refusal}`);
    }
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** The sandbox home is `mkdtemp(<sandboxBase>/<SANDBOX_PREFIX>)`. */
export const SANDBOX_PREFIX = 'wmux-fr-';

/**
 * Where the sandbox home is made. macOS: /tmp, not os.tmpdir(). The daemon's
 * Unix sockets live under the home (~/.wmux<suffix>/session-<id>.sock), and
 * macOS's per-user temp dir (/var/folders/<2>/<28>/T) pushes them past the
 * 104-byte sun_path limit, so every pty:create fails with `listen EINVAL`.
 * The same choice e2e/lib.mjs makeSandbox and src/test-utils/isolateDataDir.ts
 * make.
 */
export function sandboxBase(platform = process.platform, tmpdir = os.tmpdir()) {
  return platform === 'darwin' ? '/tmp' : tmpdir;
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
 *   - Both: CODEX_HOME points into the sandbox. control-wmux's scrub keeps
 *     it (it drops only WMUX_* and CLAUDE*), so an owner's CODEX_HOME would
 *     otherwise lead the app to their real Codex config.
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
  set('CODEX_HOME', p.join(home, '.codex'));
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
    // zsh reads its dotfiles from ZDOTDIR when set (wmux's stubs then source
    // the user's from there): the sandbox home's, never the owner's.
    drop('ZDOTDIR');
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
    rows.push({
      ProcessId: Number(m[1]),
      ParentProcessId: Number(m[2]),
      Name: path.posix.basename(m[4].split(' ')[0] || ''),
      // The same parser control-wmux records the app's creation time with.
      CreationDate: parseLstart(m[3]),
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
 *
 * `roots` are identities ({ ProcessId, CreationDate }) pinned when the run
 * started each process, never bare pids: a root expands only while the
 * process holding its pid is still the one recorded. After the app or daemon
 * dies its pid can be reused, and expanding a bare pid would record the
 * stranger and its whole subtree for the kill sweep. collectProcessTree checks
 * creation time on every parent-to-child edge, but not on the root itself.
 */
export function runProcessTree(rows, roots) {
  const live = survivors(roots.filter(Boolean), rows).map((r) => r.ProcessId);
  const { pids } = collectProcessTree(rows, live);
  return rows.filter((r) => pids.has(r.ProcessId));
}

/**
 * The daemon's identity (its row in `rows`), pinned the first time it can be
 * tied to this run; null until then. `daemonPid` comes from the pid file in
 * the sandbox, which only names a pid, so one of these must also hold:
 *   - its pid AND creation time are already in `recordedTree`, the tree
 *     expanded from the verified app (it was seen as the app's child);
 *   - its parent pid is the recorded app's, it was created after the app,
 *     and no other process holds the app's pid now (Windows keeps a dead
 *     parent's pid on its children, so this still works after the app exits);
 *   - `envOwned`: its own environment carries this run's suffix (POSIX: a
 *     macOS daemon runs as a launchd job, never the app's child).
 */
export function adoptDaemon({ daemonPid, rows, app, recordedTree = [], envOwned = false }) {
  if (!Number.isInteger(daemonPid) || daemonPid <= 0) return null;
  const row = rows.find((r) => r.ProcessId === daemonPid);
  if (!row || row.CreationDate == null) return null;
  if (survivors(recordedTree, [row]).length === 1) return row;
  if (app && app.CreationDate != null && row.ParentProcessId === app.ProcessId && row.CreationDate >= app.CreationDate) {
    const holder = rows.find((r) => r.ProcessId === app.ProcessId);
    if (!holder || holder.CreationDate === app.CreationDate) return row;
  }
  return envOwned ? row : null;
}

/**
 * The suffixed paths outside the sandbox that teardown may delete: those that
 * exist now and did NOT exist at preflight. A path that was already there is
 * someone else's data (another run, or a hand-picked --suffix), never ours.
 */
export function removableLeftovers(existingNow, preExisting) {
  const pre = new Set(preExisting);
  return existingNow.filter((p) => !pre.has(p));
}

/**
 * Refuse an `--app` inside the Squirrel install root (%LOCALAPPDATA%\wmux:
 * Update.exe, the stub wmux.exe, app-X.Y.Z\wmux.exe). The installed app runs
 * the post-install reconcile on boot, which can rewrite the user PATH, the
 * autostart entry and shortcuts (src/main/postInstallReconcile.ts), whatever
 * the data suffix. Case-insensitive, as Windows paths are.
 */
export function squirrelInstallRefusal(app, localAppData, platform = process.platform) {
  if (platform !== 'win32' || !app || !localAppData) return null;
  const root = path.win32.join(localAppData, 'wmux');
  const rel = path.win32.relative(root, app);
  if (rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel)) {
    return `refusing --app ${app}: it is the installed wmux (under ${root}), whose boot reconciles the real PATH, autostart and shortcuts; pass a packaged build such as out\\wmux-win32-x64\\wmux.exe`;
  }
  return null;
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

/**
 * Teardown's last resort: kill the recorded processes still alive after
 * `stop`, never a stranger that holds a reused pid.
 *   - Windows: one windowsKillQuery call for all of them; each is killed
 *     through a handle pinned to its recorded creation time (taskkill or
 *     process.kill would act on a bare pid after the check).
 *   - POSIX: re-list right before each kill and kill only a process with the
 *     same pid AND creation time; the best a pid-addressed kill allows.
 * deps: listRows() -> rows | null, killPosix(pid), killWindows(targets) -> { [pid]: result }.
 * Returns [{ pid, result }].
 */
export async function killSurvivors(alive, { platform = process.platform, listRows, killPosix, killWindows }) {
  if (platform === 'win32') {
    const res = await killWindows(alive.map((r) => ({ pid: r.ProcessId, createdAt: r.CreationDate })));
    return alive.map((r) => ({ pid: r.ProcessId, result: res[r.ProcessId] ?? 'no result' }));
  }
  const out = [];
  for (const r of alive) {
    const rows = await listRows();
    if (rows && survivors([r], rows).length === 1) {
      await killPosix(r.ProcessId);
      out.push({ pid: r.ProcessId, result: 'killed' });
    } else {
      out.push({ pid: r.ProcessId, result: rows ? 'gone' : 'not listed, not killed' });
    }
  }
  return out;
}

/**
 * Dotfiles for the sandbox home. macOS panes start as `zsh -l -i`, and the
 * login file /etc/zprofile runs path_helper, which moves /usr/local/bin and
 * /opt/homebrew/bin ahead of the fakes: a real `claude` there would run the
 * sample task with the owner's account. ~/.zprofile runs after it (wmux's
 * stub sources the user's) and puts the fakes back in front.
 */
export function sandboxShellProfiles(fakeBin, platform = process.platform) {
  if (platform === 'win32') return [];
  return [{ name: '.zprofile', content: `export PATH="${fakeBin}:$PATH"\n` }];
}

/**
 * The line typed into a pane to learn which `claude` its shell would run,
 * written to `file`. Windows panes run PowerShell (pwsh 7, else 5.1); an
 * alias or function shows up as its CommandType, never as a path.
 */
export function paneProbeCommand(file, platform = process.platform) {
  if (String(file).includes("'")) throw new Error(`probe path must not contain a quote: ${file}`);
  if (platform === 'win32') {
    return `$c = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1; "$($c.CommandType)|$($c.Source)" | Set-Content -Encoding UTF8 -LiteralPath '${file}'`;
  }
  return `{ command -v claude || echo NOT-FOUND; } > '${file}' 2>&1`;
}

/**
 * null when the probe says the pane's `claude` is the fake in `fakeBin`,
 * otherwise why the run must not go on. `raw` is the probe file's bytes.
 */
export function paneProbeRefusal(raw, fakeBin, platform = process.platform) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  let resolved = line;
  if (platform === 'win32') {
    const [type, source] = line.split('|');
    if (type !== 'Application') return `the pane's claude is ${type ? `a ${type}` : 'not found'} (${line || 'empty probe'}), not the fake in ${fakeBin}`;
    resolved = source ?? '';
  }
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!resolved || !p.isAbsolute(resolved)) return `the pane's claude resolves to "${line || 'nothing'}", not the fake in ${fakeBin}`;
  const same = platform === 'win32'
    ? p.dirname(resolved).toLowerCase() === p.normalize(fakeBin).toLowerCase()
    : p.dirname(resolved) === p.normalize(fakeBin);
  return same ? null : `the pane's claude is ${resolved}, not the fake in ${fakeBin}; a real Claude Code would run the sample task`;
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
