// Pure parts of scripts/measure-idle-memory.mjs: parse one `ps` sample, find
// the wmux app, and group RSS the way docs/performance.md does
// (src/cli/memoryDiagnostics.ts), with the app split by process type.

/** pid → { pid, ppid, rssBytes, comm } from `ps -axo pid=,ppid=,rss=,comm=` (rss in KiB). */
export function parsePsRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024, comm: m[4] });
  }
  return rows;
}

/** `pid` and every ancestor present in the sample. */
export function ancestorsOf(rows, pid) {
  const seen = new Set();
  for (let cur = rows.get(pid); cur && !seen.has(cur.pid); cur = rows.get(cur.ppid)) seen.add(cur.pid);
  return seen;
}

const isRenderer = (comm) => /Helper \(Renderer\)|--type=renderer/.test(comm);

/**
 * The Electron main process: an app's main executable with a renderer child.
 * The daemon runs the same executable, so a name alone does not decide it.
 * Undefined unless exactly one candidate.
 */
export function findAppPid(rows) {
  const all = [...rows.values()];
  const mains = all.filter((r) => /\/Contents\/MacOS\/(wmux|Electron)$/.test(r.comm) || /\/(wmux|electron)$/.test(r.comm));
  const withRenderer = mains.filter((m) => all.some((r) => r.ppid === m.pid && isRenderer(r.comm)));
  return withRenderer.length === 1 ? withRenderer[0].pid : undefined;
}

const emptyGroup = () => ({ processes: 0, rssBytes: 0 });

/**
 * docs/performance.md's groups: the daemon; workloads (everything under the
 * daemon: shells, agents, MCP servers); the app (main and its Electron
 * helpers), split into main, renderer and other helpers (GPU, network,
 * utility: macOS names the GPU process plain `<app> Helper`). Each pid counts
 * once; `excludedPid`'s tree (the measuring script) is left out.
 */
export function groupMemory(rows, appPid, daemonPid, excludedPid) {
  const g = {
    app: emptyGroup(), appMain: emptyGroup(), appRenderer: emptyGroup(), appHelpers: emptyGroup(),
    daemon: emptyGroup(), workloads: emptyGroup(),
  };
  const add = (k, row) => {
    g[k].processes++;
    g[k].rssBytes += row.rssBytes;
  };
  for (const row of rows.values()) {
    const seen = ancestorsOf(rows, row.pid);
    if (seen.has(excludedPid)) continue;
    if (row.pid === daemonPid) add('daemon', row);
    else if (seen.has(daemonPid)) add('workloads', row);
    else if (row.pid === appPid || (seen.has(appPid) && /Helper|--type=/.test(row.comm))) {
      add('app', row);
      if (row.pid === appPid) add('appMain', row);
      else if (isRenderer(row.comm)) add('appRenderer', row);
      else add('appHelpers', row);
    }
  }
  return g;
}

/** RSS of `root` and everything under it. */
export function treeRss(rows, root) {
  let rssBytes = 0;
  let processes = 0;
  for (const row of rows.values()) {
    if (ancestorsOf(rows, row.pid).has(root)) {
      rssBytes += row.rssBytes;
      processes++;
    }
  }
  return { rssBytes, processes };
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** The median of every counter across samples of the same shape. */
export function medianOf(samples) {
  const groups = {};
  for (const k of Object.keys(samples[0].groups)) {
    groups[k] = {
      processes: median(samples.map((s) => s.groups[k].processes)),
      rssBytes: median(samples.map((s) => s.groups[k].rssBytes)),
    };
  }
  const agents = samples[0].agents.map((a, i) => ({
    kind: a.kind,
    ptyId: a.ptyId,
    processes: median(samples.map((s) => s.agents[i].processes)),
    rssBytes: median(samples.map((s) => s.agents[i].rssBytes)),
  }));
  return { groups, agents };
}
