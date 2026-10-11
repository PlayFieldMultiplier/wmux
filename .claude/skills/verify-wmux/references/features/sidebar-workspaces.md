# Sidebar and workspaces

The sidebar lists workspaces as a tree; each workspace owns its panes and terminals. A user creates, switches, renames, reorders and closes workspaces there, copies session info or opens the folder, and can hide or resize the sidebar.

## Sub-features

- `ws-create`: "New workspace" opens a picker (Empty, Browse Folder…, layout presets).
- `ws-switch`: selecting a row shows that workspace's panes.
- `ws-rename`: double-click a row or context menu "Rename workspace"; Enter commits, Escape reverts.
- `ws-close`: row ✕ then the inline "Close “<name>”?" confirm.
- `ws-reorder`: drag a row (Manual order only).
- `ws-copy-info` / `ws-open-folder`: row hover buttons "Copy session info" / "Open in Finder" ("Open in File Explorer" on Windows).
- `sb-toggle` / `sb-resize`: show/hide the sidebar; drag or arrow-key the separator.

## How to get to it (user POV)

- Sidebar header button "New workspace"; collapsed rail "New workspace (Ctrl+N)"; shortcut ⌘N (Ctrl+N); palette "New Workspace"; prefix `Ctrl+B` `c`.
- Switch: click a row; Alt+Up / Alt+Down; ⌘1..⌘8, ⌘9 = last; prefix `n` / `p`; arrow keys inside the tree.
- Rename: double-click; right-click › "Rename workspace"; ⇧⌘R; prefix `,`.
- Close: row ✕ (asks); ⇧⌘W or prefix `&` (no confirm).
- Sidebar: titlebar button "Show sidebar"; Ctrl+Shift+B (literal Ctrl); palette "Toggle Sidebar".

## Driving it with control-wmux

Preconditions:

- Baseline state (see README): one workspace "Workspace 1", on the Workspaces page.

- **Create.** Run `control-wmux click --label "New workspace"`, then `control-wmux click --role button --name "Empty Blank single pane"`. `control-wmux inspect --js "[...document.querySelectorAll('[data-sidebar-row]')].map(r => [r.getAttribute('aria-label') ?? r.textContent, r.getAttribute('aria-selected')])"` goes from one row to two, the new "Workspace 2" with `aria-selected="true"`.
- **Switch.** Run `control-wmux click --role treeitem --name "Workspace 1"` (or `--selector '[data-sidebar-row]' --nth 0`). `control-wmux inspect --js "document.querySelector('[role=treeitem][aria-selected=true]')?.textContent"` starts with `Workspace 1`.
- **Rename.** Run `control-wmux press --key Meta+Shift+R`, `control-wmux press --key Meta+a` (the field is prefilled with the old name), `control-wmux type --text verify-ws`, `control-wmux press --key Enter`. The same read-back lists `verify-ws`.
- **Copy session info.** The row buttons appear on hover: run `control-wmux hover --selector '[data-sidebar-row]' --nth 0`, then `control-wmux click --selector '[data-workspace-action="copy-info"]' --nth 0`. A `status` "Copied!" toast appears (`control-wmux snapshot --as copied`).
- **Close with confirm.** With two workspaces, run `control-wmux hover --selector '[data-sidebar-row]' --nth 1`, `control-wmux click --selector '[data-workspace-action="close"]' --nth 1`, then `control-wmux wait-settle --selector '[data-workspace-close-confirm]'` and `control-wmux snapshot --selector '[data-workspace-close-confirm]' --as close-ws-confirm` (dialog `Close “verify-ws”?`, "1 terminal(s) will be closed", Cancel, Close) and `control-wmux click --selector '[data-workspace-close-confirm] button' --nth 1` ("Close"; index 0 is "Cancel"). The row count drops back to 1.
- **Toggle sidebar.** Run `control-wmux click --selector '[data-sidebar-toggle]'`. `control-wmux inspect --js "document.querySelector('[data-sidebar-toggle]').getAttribute('aria-pressed')"` flips `true` → `false`; click again to restore.
- **Resize.** Run `control-wmux press --key ArrowRight --selector '[data-sidebar-resize]'`. The separator's `aria-valuenow` increases (264 → 280 by default); `press --key Enter` with the same target resets it to 264.
- **Proof.** `control-wmux snapshot --selector '[data-sidebar-tree]' --as workspaces` lists the rows.

## Gotchas

- The row action buttons are hidden (`opacity-0`, no pointer events) until the row is hovered: `click` on them alone fails with "… intercepts pointer events"; `hover` the row first. A count-only check sees them as present either way.
- ⇧⌘W closes the active workspace immediately with no confirm and kills its terminals; only the row ✕ asks.
- The last workspace cannot be closed; create a second one before proving close.
- The toggle's accessible name is always "Show sidebar"; assert `aria-pressed`, not the name. The tooltips that say "Ctrl+B" are wrong: Ctrl+B is the prefix, the toggle is Ctrl+Shift+B.
- "Browse Folder…" opens a native dialog CDP cannot drive; use "Empty".
- A row's accessible name includes status words; match with `--role treeitem` and a prefix check via `inspect`, not an exact name, once agents run.
- "Open in Finder" opens the real Finder window; nothing appears in the DOM on success.
- Every new workspace spawns a real shell.
