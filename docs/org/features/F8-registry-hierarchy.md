# F8: Registry hierarchy (windows, systems, workspaces, agents)

Status: designed, not built. Green field: nothing in this doc exists yet, so no name or layout here has to match an earlier setup. Decisions 1 to 4 are made by AO_WMUX under the green-field grant (Victor, 2026-10-30). Decision 5 stays with Victor. LEDGER L-20 tracks this doc.

## 1. Goal

One registry states, for every window, system, workspace and agent, which parent it belongs to, which window hosts it, and which config it runs under. A `WMUX_DATA_SUFFIX` value names one running wmux instance. The registry names what that instance is for.

## 2. Windows (zoom levels)

Each window is one wmux instance with its own data suffix. Each has its own userData, daemon pipe and `~/.wmux<suffix>` directory (RESEARCH-DIGEST section 2, verified). Because the single-instance lock is per userData, the windows run side by side.

| Window | Suffix | Hosts | Zoom |
|---|---|---|---|
| PFM office | `-pfm` | Agents of the systems below it, plus a read-only view of the whole tree | widest |
| LeagueOS | `-leagueos` | The LeagueOS system and everything nested in it | middle |

A knowledge window for wmux-app (studying the product's own source) is not created. It would need its own reason and its own suffix, and nothing in the org needs it yet.

## 3. Nesting, and the one-owner rule

```
PFM (window -pfm)                      view: whole tree, read-only
└── LeagueOS (system; window -leagueos)  owns its agents here
    └── MERIDIAN / BLUE / OTTOBOT (system)
        └── workspaces, panes and agents
```

**One-owner rule.** A system's agents run in exactly one window. The `-pfm` window shows every system but starts no agent that another window owns. This prevents two instances from driving the same pane, the same account, or the same daemon.

The folder tree nests the same way: `AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_` (LEDGER L-09). The folder and the registry must agree on each parent. The registry is the source; the folder is checked against it.

## 4. What the registry records

One row per node:

- `id`: a stable slug, matching the folder name where one exists.
- `kind`: `window`, `system`, `workspace` or `agent`.
- `parent`: the containing node's id. A window has none.
- `window`: the suffix of the window that owns the node's agents.
- `config`: the launcher and account the node runs under. Credentials are never stored here; only the name of the vessel that holds them.
- `owner`: the agent or person accountable for the node.

## 5. Decisions

| # | Question | Decision | Reason |
|---|---|---|---|
| 1 | Window suffixes | `-pfm` and `-leagueos`. `-wmux-app` is not created. | Green field: no knowledge window has a reason yet. The two real zoom levels are the office and LeagueOS. |
| 2 | Where the registry lives | `config/org/registry.yaml` in this fork | The F7 launchers and the F1 isolation check read it, so it belongs with the code, under review. |
| 3 | Who keeps it | The coordinator (MERIDIAN_BLUE) keeps it, changed only by reviewed PR | One writer until a second is needed. A steward role under F6 waits for that need. |
| 4 | Is LeagueOS its own window | Yes: `-leagueos` owns the LeagueOS agents. `-pfm` views them read-only. | The one-owner rule (section 3) needs a single window per system. |
| 5 | Accounts: which Claude logins each system runs under (L-11) | **Open, Victor.** The registry will record the choice once made. | Logins are real accounts with real quota. This is not a design choice. |

## 6. Verification (when built)

- Each node's `window` matches the suffix on the running process, read from the `[Main] WMUX_DATA_SUFFIX` log line.
- No two windows share a `session.json` (F1 isolation check).
- No agent appears under two windows (the one-owner rule).
- Every folder under `AS\MERIDIAN\...` has a registry row whose `parent` matches its folder parent.

## 7. Not in this doc

- The launcher scripts (F7).
- The isolation mechanics (F1).
- The work stream (F5).
