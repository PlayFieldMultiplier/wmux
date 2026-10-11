# Rail pages: Fleet, Schedules, Remote, Git

The left rail ("Navigation") switches the main area between Workspaces and four pages: Fleet (every agent on one attention board), Schedules (agent runs at set times), Remote (other PCs and phone access) and Git (issues, pull requests and worktrees of the active repo). On a fresh profile each page shows an empty state.

## Sub-features

- `rail-nav`: rail buttons Workspaces, Fleet, Schedules, Remote, Git; the current one has `aria-current="page"`.
- `fleet-empty`: "No agents running" with a "New agent" button and a List/Board layout switch.
- `schedules-empty`: "Schedule a task" with six template buttons and "New schedule".
- `remote-empty`: "Nothing connected yet", this computer's status, "Share & pair…", "Details", "Connect a PC…".
- `git-no-repo`: "Not a git repository — focus a pane inside a repo." with tabs Issues, Pull Requests, Worktrees.
- `git-repo`: with the active pane inside a repo, lists from `gh` (needs `gh` auth).

## How to get to it (user POV)

- Rail buttons (icons, names in tooltips).
- Fleet: ⇧⌘A toggles; palette "Open Fleet View". Remote and Schedules close with Escape.
- Git: the status bar branch button "<branch> — Open the Git page" when the workspace has a branch.

## Driving it with control-wmux

Preconditions:

- Baseline state; on a fresh profile the first Fleet visit starts the onboarding tour (see first-run-wizard.md): skip it with `control-wmux click --testid onboarding-skip`.

- **Fleet.** Run `control-wmux click --selector '[data-sidebar-nav="fleet"]'`, then `control-wmux wait-settle --selector '[data-rail-page="fleet"]'`. `control-wmux snapshot --as fleet` shows `region "Fleet"`, `radiogroup "Layout"` (List checked, Board), `heading "No agents running"`, `button "New agent"`. Run `control-wmux click --role radio --name Board`; the Board radio becomes checked inside `[data-testid="fleet-layout"]` (switch back with `--name List`).
- **Schedules.** Run `control-wmux click --selector '[data-sidebar-nav="schedules"]'`. Snapshot shows `region "Schedules"`, "Filter schedules", "New schedule", `heading "Schedule a task"` and `list "Start from a template"` with "Morning repo briefing …" etc. `[data-schedules-empty]` is present.
- **Remote.** Run `control-wmux click --selector '[data-sidebar-nav="remote"]'`. Snapshot shows `heading "Remote"`, "Connect a PC…", "Nothing connected yet", "This computer … Phone access: off", "Share & pair…", "Details". `[data-remote-empty]` is present.
- **Git, no repo.** With the pane in `~` or a scratch folder, run `control-wmux click --selector '[data-sidebar-nav="git"]'`. Snapshot shows `heading "Git"`, the repo switcher "Repository: Choose a repository. Choose another", "Not a git repository — focus a pane inside a repo.", "Refresh", and `tablist "Git views"` with Issues selected. `[data-git-no-repo]` is present.
- **Git tabs.** Run `control-wmux click --selector '[data-git-page-tab="worktrees"]'`; that tab becomes selected.
- **Back.** `control-wmux click --selector '[data-sidebar-nav="home"]'`; `[data-workspaces-page]` is in front again.

## Gotchas

- Rail button names grow with state ("Fleet, needs you 2", "Git, a pull request needs a look…"); prefer `[data-sidebar-nav="…"]`.
- Schedules appears only once the daemon answers; wait for `[data-sidebar-nav="schedules"]` instead of asserting it right after launch.
- Do not save a schedule ("Create") or press "Run now": that persists an automation and launches a real agent. Opening a template or the editor is safe.
- Do not pick an agent from "New agent": it starts a real agent (accounts, network). Opening and closing the picker is safe.
- Never open "Connect a PC…": opening the dialog turns A2A on (persisted), creates a pairing invite and writes the clipboard. Do not start phone pairing from "Share & pair…" either.
- Git with a repo runs `gh` (network, auth); without auth the page becomes a "Connect GitHub" card. Never press "Connect GitHub" (device login stored in gh's own config) or any ship/review/hand-off action.
- The Git tab, repo choice and layout are remembered in localStorage per profile.
- The page snapshot also contains this computer's host name; keep that out of shared write-ups.
