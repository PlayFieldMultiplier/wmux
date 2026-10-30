# F8: Registry hierarchy (windows, workspaces, systems, agents)

Status: proposed. Victor, 2026-10-30. Not built. Decision needed before any suffix is renamed (see LEDGER L-19 and L-20).

## 1. Goal

One registry states, for every window, workspace, system and agent, which parent it belongs to, and which config it runs under. The registry sits above the `WMUX_DATA_SUFFIX` values. A suffix only names one instance of the wmux program. The registry names what that instance is for.

## 2. The three zoom levels

Victor's model: the same product seen at three levels of detail, each one its own window (a separate wmux instance with its own data suffix).

| Window (suffix, proposed) | What it contains | Zoom |
|---|---|---|
| `-pfm` | The PlayFieldMultiplier office: every system the org runs | widest |
| `-leagueos` | The LeagueOS product system and its teams | middle |
| `-wmux-app` (only if the wmux knowledge workspace is built) | Workers who study the wmux app's own source and behaviour | the product itself |

Each window is a separate process with its own userData, daemon pipe and `~/.wmux<suffix>` directory (RESEARCH-DIGEST section 2, verified). The single-instance lock is per userData, so the windows can run side by side.

The `-wmux-app` row is conditional. Without a separate knowledge workspace, it is redundant and should not exist (Victor, 2026-10-30).

## 3. Nesting

Victor's statement: Meridian-Blue-OTTOBOT is its own system, inside LeagueOS, inside PFM.

```
PFM (window -pfm)
└── LeagueOS (system; window -leagueos)
    └── MERIDIAN / BLUE / OTTOBOT (system: the Blue team)
        ├── workspaces, panes and agents (see research/MERIDIAN-ORG-CHART-2026-10-29.md)
        └── ...
```

The folder tree already nests the same way: `AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_` (LEDGER L-09). This is evidence that the folder and the registry should agree, not a second source of truth.

## 4. What the registry records

For each node, one row:

- `id`: a stable name (the folder name or a short slug).
- `kind`: `window`, `system`, `workspace`, `agent`.
- `parent`: the id of the containing node. A window has no parent.
- `window`: the suffix of the window that hosts the node.
- `config`: the config (launcher, `CLAUDE_CONFIG_DIR` account) the node runs under. Credentials are never stored here, only the name of the vessel that holds them.
- `owner`: the agent or person accountable for the node.

## 5. Open decisions (Victor)

1. **Suffix names.** Are the window suffixes `-pfm` and `-leagueos`? Is `-wmux-app` a real window, or dropped?
2. **Where the registry lives.** A file in this fork (`config/org/registry.yaml`), or in the office repo `Office-Of/KPFM-1`?
3. **Who keeps it.** The coordinator, or a registry steward role under F6?
4. **Is LeagueOS its own window.** Or does LeagueOS run inside `-pfm` as a system, with `-leagueos` only as a zoom view of the same instance?
5. **Accounts.** Which Claude logins each system runs under (L-11). The registry records the choice; it does not decide it.

## 6. Verification (when built)

- Each node's `window` matches the suffix on the running process, read from the `[Main] WMUX_DATA_SUFFIX` log line.
- No two windows share a `session.json` (F1 isolation check).
- The shell folder path and the registry agree on each system's parent.

## 7. Not in this doc

- The launcher scripts (F7).
- The isolation mechanics (F1).
- The work stream (F5).
