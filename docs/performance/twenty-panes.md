# 20 terminals for 30 minutes

A soak benchmark for the question "does wmux stay responsive and bounded with
20 terminals open for half an hour?". It drives a packaged wmux in an isolated
instance, keeps 20 panes open (6 streaming, 14 idle shells), and samples input
latency, lost input, output stalls and memory every 10 seconds.

Script: `scripts/twenty-pane-stability.mjs` (measurement core in
`scripts/lib/twenty-pane-stability.mjs`, unit-tested by
`scripts/__tests__/twentyPaneStability.test.mjs`).

## Method

**Instance.** The harness launches the packaged app with a fresh temporary
`HOME`/`USERPROFILE`/`APPDATA` and a unique `WMUX_DATA_SUFFIX`, which re-keys
every pipe, token, data directory and the single-instance lock. A running wmux
on the same machine is not touched. The harness drives the app over CDP only
after the app logs `CDP listening on port N` (its own port-ownership check),
only drives renderer pages served from the launched app's directory, and kills
only the processes it launched or that its own sandbox's pid file names. On
macOS it passes `--use-mock-keychain`; without a login keychain under the
sandbox `HOME`, Chromium's Safe Storage request blocks startup behind a
keychain dialog.

**Layout.** 20 panes in 4 workspaces of 5. The first workspace is the boot
workspace; the others come from `mcp.claimWorkspace`. Each workspace is filled
with `pane.split`, always splitting its largest pane, so panes form a grid
rather than a spiral of slivers. Every workspace is shown once with the real
`Alt+ArrowDown` shortcut before the run, and the run starts only when every
pane reports a started terminal. Most panes therefore sit in hidden
workspaces, which matches real use and exercises hidden-pane retention and
reveal catch-up.

**Workload.** Every shell gets a two-character prompt (`> `) so markers never
wrap, and PowerShell 7 inline prediction is turned off. Six panes, spread
across the workspaces, run a synthetic Node producer, started by typing its
command into the shell:

- every 100 ms it repaints a status row (cursor save, row 1, reverse video,
  restore), like a TUI;
- it appends colored log lines with Korean text and a symbol, up to
  `--rate-kib` (default 16) thousand characters per second (about 16 KiB/s);
- it honors stdout backpressure: when a write reports a full buffer it skips
  ticks until `drain`;
- stdin is raw and edits a one-line input box on row 2, repainted whole on
  every key, as agent TUIs do.

The other 14 panes are idle shells. Writes stay small: markers are about 7
bytes and are paced 20 ms apart. A single multi-MiB write has stalled ConPTY
before.

**Each sample** (every `--sample-sec`, default 10 s):

1. Focus moves. Every third sample switches workspace with `Alt+ArrowDown`.
   Every sample then focuses the next pane of the current workspace with
   `pane.focus`. If no terminal has keyboard focus afterwards, the harness
   clicks the largest visible terminal and records a focus miss.
2. Focused keystrokes (`--keys`, default 4). The harness types a unique marker
   such as `qz7k2aj` with CDP keyboard events, then erases it with Backspace.
   Latency is measured inside the renderer, from the keydown of the marker's
   last key to the first `pty.onData` chunk that completes the marker, with
   control sequences stripped. It also records the next animation frame. The
   first marker after the focus move is reported separately as
   "afterSwitch".
3. Pane probes. A marker is written to every pane with
   `electronAPI.pty.write`, matched in `pty.onData`, then erased. This covers
   hidden and idle panes, which a keyboard test cannot reach.
4. Stalls. One `pty.onData` subscriber records, per pane, the time of the last
   output. A streaming pane whose output stops for `--stall-ms` (default
   5000) is a stall episode, recorded with its length when output resumes.
   A streaming pane still silent at sample time is listed as silent.
5. Window cadence. 20 rAF intervals; a median above 50 ms marks the sample
   throttled (occluded window or locked screen).
6. Memory.
   - `daemon.ping {includeMemory}`: daemon RSS, JS heap, ring bytes,
     socket/resync queue bytes, session states, event-loop lag.
   - `perf.status {includeMemory}`: Electron working sets per process type.
   - Every `--tree-every` samples (default 3), an OS process-tree sample of
     the app and daemon, including shells and producers. Windows uses CIM
     and the pid-reuse-guarded tree walk from `perf-process-tree.mjs` and
     `perf-process-classify.mjs`. macOS and Linux use `ps`.

Each sample is appended to `samples.ndjson` as soon as it is taken, so a run
that dies early keeps its data. The summary is written at the end, on Ctrl+C,
and on a fatal error.

## Metrics

| Metric | Source | Meaning |
| --- | --- | --- |
| Keyboard echo p50/p95/max | renderer keydown → `pty.onData` | Full keyboard → main → daemon → PTY → shell or TUI → renderer round trip for the focused pane |
| First key after a switch | same, first marker per sample | Echo right after a pane or workspace focus change |
| Next frame p50/p95 | rAF after the echo | Approximates the frame that draws the glyph. It is not a GPU present timestamp |
| Probe echo, streaming / idle | `pty.write` → `pty.onData` | Round trip for every pane, hidden ones included |
| Dropped | marker not echoed within 3 s | Lost or badly delayed input. Echoes arriving after the timeout are counted as late |
| Wrong pane | keyboard marker echoed by another pane | Focus went somewhere other than the pane `pane.focus` selected |
| Stall episodes | output gap ≥ 5 s on a streaming pane | The pane stopped updating, at the renderer's IPC input |
| Daemon RSS, Electron working sets, process tree | RPC and OS samples | First, last, max and growth per hour, from a least-squares fit; growth is reported only for runs of 10 minutes or more |
| Throttled samples | rAF median > 50 ms | Frame numbers in those samples are not trustworthy |

Caveats:

- RSS, working sets, heap, ring and queue counters overlap. Do not add them
  up. See [Memory diagnostics](../performance.md#memory-diagnostics).
- Probe latency includes the shell line editor handling a 7-byte write in one
  piece. That costs zsh about 10 ms on macOS and differs from per-key typing.
  Compare probes across time and between pane classes, not against keyboard
  echo.
- A stall is measured where output reaches the renderer over IPC. Painting
  of hidden panes is deferred by design and is not measured. A stall in the
  producer, the PTY, the daemon or main all show up the same way.
- This is a soak with a fixed synthetic workload, not a p99 latency study and
  not a model of any particular agent.

## How to run

Prerequisites: a packaged build, Node, and an unattended desktop session that
stays unlocked with the wmux window not minimized. A locked screen or a
minimized window throttles rAF; the run still completes, but frame numbers
are flagged.

Windows (PowerShell, from the repo root):

```powershell
npm run package
node scripts/twenty-pane-stability.mjs
```

The defaults are `--minutes 30 --panes 20 --streaming 6 --per-workspace 5
--sample-sec 10`. Setup takes about a minute before the 30 minutes start.

A smaller check:

```sh
node scripts/twenty-pane-stability.mjs --panes 4 --streaming 1 --per-workspace 2 --minutes 1 --sample-sec 5
```

Other flags: `--app <exe>` (default `out/wmux-win32-x64/wmux.exe`; on macOS
a packaged `out/` build, else `/Applications/wmux.app`), `--keys`,
`--workspace-switch-every`, `--tree-every`, `--stall-ms`, `--rate-kib`,
`--probe-timeout-ms`, `--key-timeout-ms`, `--out <dir>`, `--keep-app`.

Output goes to `out/twenty-pane-stability/<timestamp>/` (gitignored), and an
existing directory is never overwritten:

- `config.json`: platform, CPU count, memory, flags and pane layout;
- `samples.ndjson`: one JSON object per sample;
- `summary.json` and `summary.txt`.

The files hold counters, pty ids and synthetic markers only: no terminal
contents, command lines or paths.

## Results

Pending Windows run.

| Date | Platform | Build | Keyboard echo p50 / p95 / max (ms) | First key after switch p95 (ms) | Probe p95 streaming / idle (ms) | Dropped (key / probe) | Stalls | Daemon RSS first → last (MiB/h) | Electron first → last (MiB/h) | Throttled samples |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pending Windows run | | | | | | | | | | |

The 5-minute windows in `summary.json` (`windows[]`) show whether latency or
memory drifts over the run. Quote them when a single row hides a trend.
