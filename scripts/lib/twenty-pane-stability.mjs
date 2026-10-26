// Pure parts of scripts/twenty-pane-stability.mjs: argument parsing, layout and
// marker planning, the synthetic producer, shell command lines, and the run
// summary. No import-time side effects, so scripts/__tests__ can exercise the
// measurement core on synthetic samples on any platform. The driver that boots
// the app and collects samples needs a packaged wmux and is not unit-tested.

import { summarizeSamples } from '../perf-scenarios.mjs';

export const DEFAULTS = Object.freeze({
  minutes: 30,
  panes: 20,
  streaming: 6,
  perWorkspace: 5,
  sampleSec: 10,
  keysPerSample: 4,
  workspaceSwitchEvery: 3,
  treeEvery: 3,
  probeTimeoutMs: 3000,
  keyTimeoutMs: 3000,
  stallMs: 5000,
  rateKiB: 16,
});

const INT_FLAGS = {
  '--panes': 'panes',
  '--streaming': 'streaming',
  '--per-workspace': 'perWorkspace',
  '--sample-sec': 'sampleSec',
  '--keys': 'keysPerSample',
  '--workspace-switch-every': 'workspaceSwitchEvery',
  '--tree-every': 'treeEvery',
  '--probe-timeout-ms': 'probeTimeoutMs',
  '--key-timeout-ms': 'keyTimeoutMs',
  '--stall-ms': 'stallMs',
  '--rate-kib': 'rateKiB',
};

/** Parse CLI flags. Throws on unknown flags or invalid values. */
export function parseArgs(argv) {
  const out = { ...DEFAULTS, out: null, app: null, keepApp: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--keep-app') out.keepApp = true;
    else if (flag === '--out') out.out = value();
    else if (flag === '--app') out.app = value();
    else if (flag === '--minutes') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new Error('--minutes must be a positive number');
      out.minutes = n;
    } else if (flag in INT_FLAGS) {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
      out[INT_FLAGS[flag]] = n;
    } else throw new Error(`unknown flag ${flag}`);
  }
  if (out.panes < 1) throw new Error('--panes must be at least 1');
  if (out.streaming > out.panes) throw new Error('--streaming cannot exceed --panes');
  if (out.perWorkspace < 1) throw new Error('--per-workspace must be at least 1');
  if (out.sampleSec < 1) throw new Error('--sample-sec must be at least 1');
  return out;
}

/** Pane counts per workspace, e.g. (20, 5) -> [5, 5, 5, 5], (7, 5) -> [5, 2]. */
export function planLayout(panes, perWorkspace) {
  const layout = [];
  for (let left = panes; left > 0; left -= perWorkspace) layout.push(Math.min(perWorkspace, left));
  return layout;
}

/**
 * Which panes stream: spread across workspaces (first pane of each workspace,
 * then the second, ...) so hidden and visible workspaces both carry output.
 * `panes` is [{ workspaceIndex, indexInWorkspace, ... }]; returns a Set of
 * positions into that array.
 */
export function pickStreaming(panes, count) {
  const order = panes
    .map((p, pos) => ({ pos, ws: p.workspaceIndex, idx: p.indexInWorkspace }))
    .sort((a, b) => a.idx - b.idx || a.ws - b.ws);
  return new Set(order.slice(0, count).map((o) => o.pos));
}

/**
 * A marker typed into, or written to, one pane. Unique per run, never produced
 * by the producer below (it never emits "qz"), short enough not to wrap.
 */
export function markerFor(paneIndex, seq) {
  return `qz${paneIndex.toString(36)}k${seq.toString(36)}j`;
}

/**
 * Printable text of a raw output tail, for marker matching. Same rules as
 * perf-scenarios.mjs sanitizeTerminalEcho (OSC, CSI, two-byte escapes and C0
 * controls), plus CR/LF and DECSC/DECRC. Self-contained on purpose: the
 * renderer hook embeds `stripTerminalControls.toString()`, so the unit test
 * and the live matcher run the same code.
 */
export function stripTerminalControls(raw) {
  return String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_78]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/** Quote one argument for the pane's shell. */
export function quoteArg(platform, arg) {
  const s = String(arg);
  if (platform === 'win32') return `'${s.replace(/'/g, "''")}'`; // PowerShell literal string
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into a pane to start the producer (PowerShell on win32, POSIX shells elsewhere). */
export function producerCommand(platform, nodePath, scriptPath, args) {
  const parts = [quoteArg(platform, nodePath), quoteArg(platform, scriptPath), ...args.map((a) => String(a))];
  return platform === 'win32' ? `& ${parts.join(' ')}` : parts.join(' ');
}

/**
 * Typed into every pane before the run: a two-character prompt so a marker
 * never wraps in a narrow pane, and no PSReadLine inline prediction (PS 7) that
 * would paint suggestions into the echo. Windows PowerShell 5.1's PSReadLine
 * lacks -PredictionSource; the try/catch keeps that quiet.
 */
export function shellPrepCommand(platform) {
  if (platform === 'win32') {
    return "function prompt { '> ' }; try { Set-PSReadLineOption -PredictionSource None -ErrorAction Stop } catch { }; Clear-Host";
  }
  return "PS1='> '; PROMPT='> '; RPROMPT=''; clear";
}

/**
 * Source of the synthetic producer, written to the sandbox as a .cjs file.
 * Args: <tag> <KiB per second> <seconds>. Every 100 ms it repaints a status
 * row (cursor save, move to row 1, reverse video, restore: TUI-style) and
 * appends colored log lines up to the byte budget, honoring stdout
 * backpressure. Stdin is raw and edits a one-line input box on row 2 that is
 * repainted whole on every key, as TUI agents do, so a marker typed key by
 * key still arrives contiguous between log lines. Ctrl+C exits. It exits by itself after <seconds>.
 * Its output never contains "qz", so it cannot fake a marker echo.
 */
export function producerSource() {
  return `'use strict';
const tag = process.argv[2] || '0';
const kibPerSec = Number(process.argv[3]) || 16;
const seconds = Number(process.argv[4]) || 60;
const TICK_MS = 100;
const budget = Math.max(64, Math.round((kibPerSec * 1024 * TICK_MS) / 1000));
const end = Date.now() + seconds * 1000;
const spin = '|/-\\\\';
let seq = 0;
let blocked = false;
let skipped = 0;
const out = (s) => { if (!process.stdout.write(s)) blocked = true; };
process.stdout.on('drain', () => { blocked = false; });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', (d) => {
  if (d.includes(3)) process.exit(0);
  for (const ch of d.toString('utf8')) {
    if (ch === '\\x7f' || ch === '\\b') input = input.slice(0, -1);
    else if (ch === '\\r' || ch === '\\n') input = '';
    else if (ch >= ' ') input = (input + ch).slice(-64);
  }
  out('\\x1b7\\x1b[2;1H\\x1b[K> ' + input + '\\x1b8');
});
const pad = (n, w) => String(n).padStart(w, '0');
const stamp = () => { const t = new Date(); return pad(t.getHours(), 2) + ':' + pad(t.getMinutes(), 2) + ':' + pad(t.getSeconds(), 2) + '.' + pad(t.getMilliseconds(), 3); };
const timer = setInterval(() => {
  if (Date.now() >= end) {
    clearInterval(timer);
    out('\\r\\nproducer ' + tag + ' done after ' + seq + ' ticks (' + skipped + ' skipped for backpressure)\\r\\n');
    process.exit(0);
  }
  if (blocked) { skipped++; return; }
  seq++;
  let chunk = '\\x1b7\\x1b[1;1H\\x1b[7m stream ' + tag + ' seq=' + seq + ' ' + spin[seq % 4] + ' \\x1b[0m\\x1b[K\\x1b8';
  let line = 0;
  while (chunk.length < budget) {
    line++;
    chunk += '\\x1b[2m' + stamp() + '\\x1b[0m \\x1b[32mINFO\\x1b[0m worker-' + tag + ' step ' + seq + '.' + line +
      ' \\uCC98\\uB9AC \\uC644\\uB8CC \\u2713 ' + (seq * 7919 + line).toString(16).padStart(8, '0') + ' ' + '-'.repeat(24) + '\\r\\n';
  }
  out(chunk);
}, TICK_MS);
`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024;
const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/** Least-squares slope of [{x, y}] (y per unit x); null with fewer than 2 distinct x. */
export function linearSlope(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

const MIN_TREND_SEC = 600;

/** first / last / max / growth (MiB per hour, runs of 10 min or more) of a byte series [{tSec, bytes}]. */
export function memoryTrend(series) {
  const pts = series.filter((p) => Number.isFinite(p.bytes));
  if (pts.length === 0) return null;
  const mib = pts.map((p) => p.bytes / MiB);
  // A rate extrapolated from a few minutes is noise (GC, helper restarts).
  const span = pts[pts.length - 1].tSec - pts[0].tSec;
  const slope = span >= MIN_TREND_SEC ? linearSlope(pts.map((p) => ({ x: p.tSec / 3600, y: p.bytes / MiB }))) : null;
  return {
    samples: pts.length,
    firstMiB: round1(mib[0]),
    lastMiB: round1(mib[mib.length - 1]),
    maxMiB: round1(Math.max(...mib)),
    growthMiBPerHour: round1(slope),
  };
}

/** Echo outcome counts + latency summary of [{echoMs|null}] events. */
function outcome(events) {
  const echoed = events.filter((e) => Number.isFinite(e.echoMs));
  return {
    sent: events.length,
    echoed: echoed.length,
    dropped: events.length - echoed.length,
    echoMs: summarizeSamples(echoed.map((e) => e.echoMs)),
  };
}

/**
 * Turn the per-tick samples into the run summary.
 *
 * Each sample: { tSec, keyboard: [{ phase, echoMs, frameMs, wrongPane }],
 *   probes: [{ ptyId, cls, echoMs }], late: [{ kind: 'key'|'probe', lateMs }], stalls: [{ ptyId, cls, gapMs, atSec }],
 *   silent: [{ ptyId, cls, silentMs }], memory: { daemonRssBytes, electronBytes,
 *   rendererBytes, mainBytes, gpuBytes, treeBytes }, raf: { p50, throttled },
 *   focus: { workspaceSwitch, focused } }.
 * Fields may be missing on a sample; the summary skips what it does not have.
 */
export function summarizeRun(samples, { stallMs = DEFAULTS.stallMs, windowMin = 5 } = {}) {
  const keyboard = samples.flatMap((s) => s.keyboard ?? []);
  const probes = samples.flatMap((s) => (s.probes ?? []).map((p) => ({ ...p, tSec: s.tSec })));
  const stalls = samples.flatMap((s) => s.stalls ?? []);
  const late = samples.flatMap((s) => s.late ?? []);
  const lateOf = (kind) => {
    const ms = late.filter((l) => l.kind === kind).map((l) => l.lateMs);
    return { count: ms.length, maxMs: ms.length ? Math.max(...ms) : null };
  };
  const lastSilent = samples.length ? samples[samples.length - 1].silent ?? [] : [];

  const perPane = new Map();
  for (const p of probes) {
    if (!perPane.has(p.ptyId)) perPane.set(p.ptyId, { ptyId: p.ptyId, cls: p.cls, events: [] });
    perPane.get(p.ptyId).events.push(p);
  }

  const series = (key) => samples.map((s) => ({ tSec: s.tSec, bytes: s.memory?.[key] }));
  const rafP50 = samples.map((s) => s.raf?.p50).filter(Number.isFinite);

  const windows = [];
  const lastT = samples.length ? samples[samples.length - 1].tSec : 0;
  for (let from = 0; from * 60 <= lastT; from += windowMin) {
    const inWin = samples.filter((s) => s.tSec >= from * 60 && s.tSec < (from + windowMin) * 60);
    if (inWin.length === 0) continue;
    const kb = outcome(inWin.flatMap((s) => s.keyboard ?? []));
    const pr = outcome(inWin.flatMap((s) => s.probes ?? []));
    const lastMem = inWin[inWin.length - 1].memory ?? {};
    windows.push({
      fromMin: from,
      toMin: from + windowMin,
      keyboardP95Ms: kb.echoMs.p95,
      keyboardDropped: kb.dropped,
      probeP95Ms: pr.echoMs.p95,
      probeDropped: pr.dropped,
      stalls: inWin.reduce((a, s) => a + (s.stalls?.length ?? 0), 0),
      daemonRssMiB: round1((lastMem.daemonRssBytes ?? NaN) / MiB),
      electronMiB: round1((lastMem.electronBytes ?? NaN) / MiB),
    });
  }

  const kbAll = outcome(keyboard);
  const probeAll = outcome(probes);
  const summary = {
    samples: samples.length,
    durationSec: lastT,
    keyboard: {
      ...kbAll,
      afterSwitch: outcome(keyboard.filter((k) => k.phase === 'afterSwitch')),
      steady: outcome(keyboard.filter((k) => k.phase === 'steady')),
      frameMs: summarizeSamples(keyboard.map((k) => k.frameMs)),
      wrongPane: keyboard.filter((k) => k.wrongPane).length,
      late: lateOf('key'),
    },
    probes: {
      ...probeAll,
      late: lateOf('probe'),
      streaming: outcome(probes.filter((p) => p.cls === 'streaming')),
      idle: outcome(probes.filter((p) => p.cls === 'idle')),
      perPane: [...perPane.values()].map((p) => {
        const o = outcome(p.events);
        return { ptyId: p.ptyId, cls: p.cls, sent: o.sent, dropped: o.dropped, p95Ms: o.echoMs.p95, maxMs: o.echoMs.max };
      }),
    },
    stalls: {
      thresholdMs: stallMs,
      episodes: stalls.length,
      panes: [...new Set(stalls.map((s) => s.ptyId))].length,
      worstGapMs: stalls.length ? Math.max(...stalls.map((s) => s.gapMs)) : null,
      list: stalls,
      silentAtEnd: lastSilent,
    },
    memory: {
      daemonRss: memoryTrend(series('daemonRssBytes')),
      electronTotal: memoryTrend(series('electronBytes')),
      electronMain: memoryTrend(series('mainBytes')),
      renderer: memoryTrend(series('rendererBytes')),
      gpu: memoryTrend(series('gpuBytes')),
      processTree: memoryTrend(series('treeBytes')),
    },
    frames: {
      rafP50Ms: summarizeSamples(rafP50),
      throttledSamples: samples.filter((s) => s.raf?.throttled).length,
    },
    focus: {
      workspaceSwitches: samples.filter((s) => s.focus?.workspaceSwitch).length,
      focusMisses: samples.filter((s) => s.focus && s.focus.focused === false).length,
    },
    windows,
  };
  summary.flags = flagsFor(summary);
  return summary;
}

/** Plain-language findings a reader should not miss. Never a pass/fail gate. */
export function flagsFor(summary) {
  const flags = [];
  if (summary.keyboard.dropped > 0) flags.push(`${summary.keyboard.dropped} focused keystroke marker(s) not echoed within the timeout (${summary.keyboard.late.count} arrived later)`);
  if (summary.keyboard.wrongPane > 0) flags.push(`${summary.keyboard.wrongPane} keystroke marker(s) echoed in a pane other than the focused one`);
  if (summary.probes.dropped > 0) flags.push(`${summary.probes.dropped} pane probe(s) not echoed within the timeout (${summary.probes.late.count} arrived later)`);
  if (summary.stalls.episodes > 0) flags.push(`${summary.stalls.episodes} output stall(s) over ${summary.stalls.thresholdMs} ms on ${summary.stalls.panes} pane(s)`);
  if (summary.stalls.silentAtEnd.length > 0) flags.push(`${summary.stalls.silentAtEnd.length} streaming pane(s) silent at the last sample`);
  if (summary.frames.throttledSamples > 0) flags.push(`${summary.frames.throttledSamples} sample(s) with a throttled window (rAF p50 > 50 ms): frame numbers there are not trustworthy`);
  if (summary.focus.focusMisses > 0) flags.push(`${summary.focus.focusMisses} sample(s) where no terminal had keyboard focus after a switch`);
  return flags;
}

/** Compact console rendering of the summary. */
export function renderSummary(summary) {
  const lat = (o) => `p50 ${o.echoMs.p50 ?? '-'} / p95 ${o.echoMs.p95 ?? '-'} / max ${o.echoMs.max ?? '-'} ms (${o.echoed}/${o.sent} echoed, ${o.dropped} dropped)`;
  const mem = (t) => (t ? `${t.firstMiB} -> ${t.lastMiB} MiB (max ${t.maxMiB}, ${t.growthMiBPerHour ?? '-'} MiB/h)` : 'unavailable');
  return [
    `samples: ${summary.samples} over ${Math.round(summary.durationSec)} s`,
    `keyboard echo (focused pane): ${lat(summary.keyboard)}`,
    `  first key after a switch: ${lat(summary.keyboard.afterSwitch)}`,
    `  steady: ${lat(summary.keyboard.steady)}`,
    `  next frame: p50 ${summary.keyboard.frameMs.p50 ?? '-'} / p95 ${summary.keyboard.frameMs.p95 ?? '-'} ms`,
    `pane probes, streaming: ${lat(summary.probes.streaming)}`,
    `pane probes, idle: ${lat(summary.probes.idle)}`,
    `stalls (> ${summary.stalls.thresholdMs} ms): ${summary.stalls.episodes} on ${summary.stalls.panes} pane(s), worst ${summary.stalls.worstGapMs ?? '-'} ms; silent at end: ${summary.stalls.silentAtEnd.length}`,
    `daemon RSS: ${mem(summary.memory.daemonRss)}`,
    `Electron working sets: ${mem(summary.memory.electronTotal)}`,
    `  renderer: ${mem(summary.memory.renderer)}; main: ${mem(summary.memory.electronMain)}; gpu: ${mem(summary.memory.gpu)}`,
    `process tree: ${mem(summary.memory.processTree)}`,
    `rAF p50 per sample: median ${summary.frames.rafP50Ms.p50 ?? '-'} ms; throttled samples: ${summary.frames.throttledSamples}`,
    `workspace switches: ${summary.focus.workspaceSwitches}; focus misses: ${summary.focus.focusMisses}`,
    ...(summary.flags.length ? ['flags:', ...summary.flags.map((f) => `  - ${f}`)] : ['flags: none']),
  ].join('\n');
}
