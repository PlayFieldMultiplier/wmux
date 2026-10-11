# Panes and splits

A workspace is a layout of panes; each pane has a tab strip (terminal, browser and file tabs) and an action cluster. Users split panes right or down, zoom one, stash one (it leaves the layout while its session keeps running), move focus, and close tabs with a confirm.

## Sub-features

- `pane-split-right` / `pane-split-down`: add a pane beside or below the active one; the new pane becomes active.
- `pane-zoom`: toggle zoom on one pane (siblings stay mounted but hidden).
- `pane-stash`: remove the pane from the layout, session kept.
- `pane-close-tab`: tab ✕ or ⌘W asks "Close this tab? Anything running in it will be stopped."; closing the last tab collapses the pane.
- `pane-close`: ⇧⌘Q / prefix `x` closes the whole pane, no confirm.
- `pane-focus`: click, Ctrl+Shift+Arrows (literal Ctrl), ⌘⌥Arrows, Ctrl+Tab.
- `pane-overflow`: narrow panes show a "Pane actions" ⋮ menu instead of the cluster.

## How to get to it (user POV)

- Pane header buttons "Split right", "Split down", "New browser", "Stash pane", "Toggle zoom".
- Shortcuts: ⌘D split right, ⇧⌘D split down, ⌘W close tab, ⇧⌘Q close pane; prefix `Ctrl+B` then `%`, `"`, `z`, `!`, `x`.
- Palette: "Split Right", "Split Down", "Stash Pane (keep the session running)".
- Right-click the pane header for the actions menu.

## Driving it with control-wmux

Preconditions:

- Baseline state, Workspaces page, one pane, pane wide enough for the full action cluster (default window 1280x800 is).

- **Split right.** Run `control-wmux click --selector '[data-pane-action="split-right"]'`, then `control-wmux wait-settle`. `control-wmux inspect --js "({panes: document.querySelectorAll('[data-pane-root]').length, focused: document.querySelectorAll('[data-pane-focused=true]').length})"` returns `{panes: 2, focused: 1}`.
- **Split down.** Run `control-wmux click --selector '[data-pane-action="split-down"]' --nth 0`. Pane count goes up by one.
- **Zoom.** Run `control-wmux click --selector '[data-pane-action="zoom"]' --nth 0`. `control-wmux inspect --js "[...document.querySelectorAll('[data-pane-action=zoom]')].map(b => b.getAttribute('aria-pressed'))"` contains one `"true"`; run the same click again to unzoom.
- **Close tab with confirm.** Run `control-wmux click --selector '[data-surface-tab-close]' --nth 1`, then `control-wmux snapshot --testid close-tab-confirm --as close-confirm`. Dialog "Close Zsh" with "Close this tab? Anything running in it will be stopped.", "Cancel", "Close tab". Run `control-wmux click --selector '[data-close-tab-confirm]'`; the pane count drops by one.
- **Cancel path.** Same open, then `control-wmux click --selector '[data-close-tab-cancel]'`; the count is unchanged.
- **Stash.** Run `control-wmux click --selector '[data-pane-action="stash"]' --nth 1`. That `[data-pane-root]` leaves the layout (count drops) while the workspace keeps running.
- **Proof.** `control-wmux screenshot --as split` after a split shows two terminals side by side.

## Gotchas

- Background workspaces stay mounted: scope counts with `[data-pane-workspace="<id>"]` once more than one workspace exists.
- Zoom does not change the DOM pane count; hidden siblings carry `data-wmux-zoom-hidden`.
- Closing a tab always asks; closing a pane by shortcut never does. The root pane is refilled with a fresh shell instead of removed.
- Panes narrower than about 222 px show the "Pane actions" ⋮ (`[data-pane-overflow-trigger]`) instead of the cluster; its items are `[data-pane-menu-action="split-right"|…]`.
- Settings › Appearance › "Pane action buttons" off (or the Minimal preset) hides the cluster.
- Stash is disabled without a daemon (`aria-disabled`).
- Global pane shortcuts only fire on the Workspaces page, and the terminal must not swallow them (focus the pane first).
- Splitting while zoomed un-zooms first; at most 20 panes per workspace, stashed ones included.
