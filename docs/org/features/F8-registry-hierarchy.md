# F8: Registry hierarchy (windows, systems, workspaces, agents)

Status: designed, not built. Green field: nothing in this doc exists yet, so no name or layout here has to match an earlier setup. Decisions 1 to 4 are made by AO_WMUX under the green-field grant (Victor, 2026-10-30). Decision 5 stays with Victor. LEDGER L-20 tracks this doc.

## 1. Goal

One registry states, for every window, system, workspace and agent, which parent it belongs to, which window hosts it, and which config it runs under. A `WMUX_DATA_SUFFIX` value names one running wmux instance. The registry names what that instance is for.

## 2. Windows (zoom levels)

Each window is one wmux instance with its own data suffix. Each has its own userData, daemon pipe and `~/.wmux<suffix>` directory (RESEARCH-DIGEST section 2, verified). Because the single-instance lock is per userData, the windows run side by side.

A window is a process and data boundary only. It says nothing about which Claude login an agent uses. Any window can run agents under any login configuration (Victor, 2026-10-30). The login is chosen per agent at launch, not per window and not per system.

| Window | Suffix | Hosts | Zoom |
|---|---|---|---|
| PFM office | `-pfm` | The office's own agents (roster and coordination), plus a read-only view of every system. It starts no agent that a system window owns. | widest |
| LeagueOS | `-leagueos` | The LeagueOS system's agents, including the MERIDIAN-BLUE-OTTOBOT system nested in it | middle |
| AO_WMUX product window | `-wmux-app` | AO_WMUX's own full window: the product-understanding workspace for the wmux app itself. Owned by AO_WMUX (Victor, 2026-10-30). Subdivisions in section 8. | the product itself |

The `-wmux-app` window is the full-window version of AO_WMUX's own pane and surface. AO_WMUX chooses its subdivisions and owns its targets (section 8).

## 3. Nesting, and the one-owner rule

```
PFM (window -pfm)                      view: whole tree, read-only
└── LeagueOS (system; window -leagueos)  owns its agents here
    └── MERIDIAN / BLUE / OTTOBOT (system)
        └── workspaces, panes and agents
```

**One-owner rule.** A system's agents run in exactly one window. The `-pfm` window shows every system but starts no agent that another window owns. This prevents two wmux instances from driving the same pane or the same daemon. It does not limit logins: an agent's login is a separate choice (section 2).

The folder tree does not yet match this nesting. On disk, `AS\MERIDIAN` and `AS\LeagueOS` are siblings directly under `AS`. The shell folder `AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_` (LEDGER L-09) sits under MERIDIAN. The registry is the source for parents. Each folder's parent is compared with it and any mismatch is reported. A folder is not moved to match, and the registry is not changed to match a folder, without a separate decision.

## 4. What the registry records

One row per node:

- `id`: a stable slug, matching the folder name where one exists.
- `kind`: `window`, `system`, `workspace` or `agent`.
- `parent`: the containing node's id. A window has none.
- `window`: the suffix of the window that owns the node's agents.
- `config`: the launch configuration of an agent: the launcher, the model, and the Claude login (`CLAUDE_CONFIG_DIR`). Only agent rows carry it. Windows, systems and workspaces do not, because a login is never a property of a window or a system. Credentials are never stored here; only the name of the vessel that holds them.
- `owner`: the agent or person accountable for the node.

## 5. Decisions

| # | Question | Decision | Reason |
|---|---|---|---|
| 1 | Window suffixes | `-pfm` (office), `-leagueos` (LeagueOS), `-wmux-app` (AO_WMUX's product window). | Green field. Victor, 2026-10-30: `-wmux-app` is AO_WMUX's own window for understanding the product. It is a separate purpose from the office and from LeagueOS, so it keeps its own suffix. |
| 2 | Where the registry lives | `config/org/registry.yaml` in this fork | The F7 launchers and the F1 isolation check read it, so it belongs with the code, under review. |
| 3 | Who keeps it | The coordinator (MERIDIAN_BLUE) keeps it, changed only by reviewed PR | One writer until a second is needed. A steward role under F6 waits for that need. |
| 4 | Is LeagueOS its own window | Yes: `-leagueos` owns the LeagueOS agents. `-pfm` views them read-only. | The one-owner rule (section 3) needs a single window per system. |
| 5 | Which Claude login an agent uses (L-11) | **Not a window or system property.** Any window can run any login configuration. The registry records the login on each agent row. | Victor, 2026-10-30: "any window can run any configuration of claude logins." This replaces the earlier version, which tied logins to systems. The choice of login for each agent (shared quota or separate) is still open under L-11. |

## 6. Verification (when built)

- Each node's `window` matches the suffix on the running process, read from the `[Main] WMUX_DATA_SUFFIX` log line.
- No two windows share a `session.json` (F1 isolation check).
- No agent appears under two windows (the one-owner rule).
- Each system's registry `parent` is compared with its folder parent. A mismatch is reported, not auto-fixed.

## 7. Not in this doc

- The launcher scripts (F7).
- The isolation mechanics (F1).
- The work stream (F5).

## 8. The `-wmux-app` window (AO_WMUX)

Owner: AO_WMUX. Purpose: understand the wmux product from its own source and behaviour, and work with it. AO_WMUX chose these subdivisions (Victor, 2026-10-30: "You choose its subdivisions. You own it.").

| Workspace | Covers | Source of truth | Evidence file |
|---|---|---|---|
| W1 source | Entrypoints, and the module map of the locked 3.38.1 source: main, daemon, renderer, shared, company, mcp, preload | locked checkout `openwong2kim\wmux\checkout\tag-v3.38.1` | `docs/org/research/SOURCE-MAP-3.38.1.md` (planned, L-22) |
| W2 behaviour | One verified claim per row, each with its file and line in the locked checkout | the same checkout; live checks only when the launch rule allows | `docs/org/research/BEHAVIOUR-3.38.1.md` (planned, L-23) |
| W3 upstream | Watch `openwong2kim/wmux` issues, PRs and releases, read-only, with dated entries | GitHub | `docs/org/research/UPSTREAM-WATCH.md` (planned, L-24) |
| W4 fork | Review of `PlayFieldMultiplier/wmux` PRs and the org design set | the fork at each PR head | PR links in LEDGER |

Rules for this window:

- Every claim cites a file and line in the locked checkout, or it is marked UNVERIFIED.
- Large source reading is delegated to a cheap subagent with a written brief. AO_WMUX reviews the result.
- No window is launched without Victor's approval (the standing launch rule). W2's live checks wait for that approval. Nothing else in this section needs it.
