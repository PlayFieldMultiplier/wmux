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

The registry has two kinds of field, and they are never mixed in one row.

**Stable fields** (kept in `config/org/registry.yaml`, changed only by reviewed PR):

- `id`: a stable slug, matching the folder name where one exists. This is the identity.
- `kind`: `window`, `system`, `workspace` or `agent`.
- `parent`: the containing node's `id`. A window has none.
- `window`: the suffix of the window that owns the node's agents.
- `config`: the agent's launch configuration: the launcher, the model, and the Claude login name (`CLAUDE_CONFIG_DIR` once resolved). Only agent rows carry it. Credentials are never stored here, only the name of the vessel that holds them.
- `owner`: the agent or person accountable for the node.

**Transient fields** (never written to the registry, never treated as current):

- `ptyId`, `paneId`, `surfaceId`, `workspaceId`, process ids, and live status (`agentStatus`, `live`).
- These change on every restart, split, or relaunch. They are resolved at the moment of use, from the live roster (`surface_list` and `a2a_discover`, which are themselves per-call snapshots), and the result is used once and discarded.
- A discovery listing that names a pane is a snapshot. Reading a pane by an ID taken from one can return a different pane. Confirm identity by title and agent name before typing (recorded in `C:/.______/.KADMON/PLAY__/FIELD_/MULTI_/PLIER_/_/AS/MERIDIAN/BLUE/OTTOBOT/_/AS/WMUX/APP/_/HANDOFF-2026-10-30.md`, outside this repo).

Rule: a file on disk that lists agents is a claim about the past. Stable identity comes from the stable fields. Where an agent is now comes only from a live read. If a transient value appears in a stable file, it is a defect.

## 5. Decisions

| # | Question | Decision | Reason |
|---|---|---|---|
| 1 | Window suffixes | `-pfm` (office), `-leagueos` (LeagueOS), `-wmux-app` (AO_WMUX's product window). | Green field. Victor, 2026-10-30: `-wmux-app` is AO_WMUX's own window for understanding the product. It is a separate purpose from the office and from LeagueOS, so it keeps its own suffix. |
| 2 | Where the registry lives | `config/org/registry.yaml` in this fork | The F7 launchers and the F1 isolation check read it, so it belongs with the code, under review. |
| 3 | Who keeps it | The coordinator (MERIDIAN_BLUE) keeps it, changed only by reviewed PR | One writer until a second is needed. A steward role under F6 waits for that need. |
| 4 | Is LeagueOS its own window | Yes: `-leagueos` owns the LeagueOS agents. `-pfm` views them read-only. | The one-owner rule (section 3) needs a single window per system. |
| 5 | Which Claude login an agent uses (L-11) | **Not a window or system property, and not hard-coded.** Any window can run any login configuration. The login is a registry default per system or window, overridable per agent. See section 9. | Victor, 2026-10-30: "any window can run any configuration of claude logins" and "accounts should not be so hard coded." Defaults and the quota-switch rule are in section 9. |

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

## 9. Account defaults and quota switching

Victor, 2026-10-30: "Accounts should not be so hard coded. You can default the Meridian or PFM to sharksandwich and default your own wmux app window to DarienSirius if you want, but agents should also know how to install a rabbit agent to switch accounts when quota limits near."

### 9.1 Defaults (not fixed; overridable)

| Scope | Default login name | Override |
|---|---|---|
| `-pfm` office window | `sharksandwich` | per system, per agent |
| MERIDIAN and PFM systems | `sharksandwich` | per agent |
| `-wmux-app` window (AO_WMUX) | `DarienSirius` | per agent |
| `-leagueos` window | inherits `-pfm` unless set | per system, per agent |

Rules:

- A default is a value in `config/org/registry.yaml`, read at launch. No launcher hard-codes a login.
- The name is a registry key. Resolving it to a real Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) is a separate, verified step. Until it is verified, a default is a name only. AO_WMUX has not verified that `sharksandwich` or `DarienSirius` maps to a live Claude login on this machine.
- Credentials are never written into the registry (section 4).

### 9.2 Quota switching

- Agents must be able to move to another account when a quota limit nears. The mechanism is a rabbit agent that performs the switch.
- The existing roles are the authority: rabbit-0 is the quota guardian and login-dance authority (`C:\Users\victorb\.claude\agents\hazrat-rabbit.md`, `rc-and-wmux.md`). This doc does not create a new authority.
- The requirement on the registry: each agent row names its primary login and an ordered fallback list, so a rabbit can switch without a human choosing the account at that moment.
- Open for Victor: the fallback order per system, and whether a switch may run without a human present (the standing rule is that irreversible account actions need approval). Until decided, a switch is a proposal, not an automatic action.

## 10. Account order on this machine (correction, Victor 2026-10-31)

- This machine is ottobot. ottobot has no account of its own.
- Preference order here: DarienSirius first, sharksandwich second. Both are non-machine-scoped agentic accounts.
- ottopoet.thesean is the ottopoet computer's preference. It is not used as a preference on this machine.
- Section 9.1 defaults are updated to match: the `-wmux-app` window and AO_WMUX use DarienSirius; the MERIDIAN and PFM systems use sharksandwich, as the second choice.
- The earlier entry that preferred ottopoet-thesean came from reading the office procedure for the ottopoet computer. It was applied in error and is withdrawn.
