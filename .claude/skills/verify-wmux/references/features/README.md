<!--
Structure (baseline preconditions, driving conventions, proof and skip
reporting, feature entry contract) adapted from pstack
skills/create-verification-skill/references/feature-map-example/README.md
(https://github.com/cursor/plugins, MIT, Copyright (c) 2026 Lauren Tan).
See THIRD_PARTY_NOTICES.md.
-->

# wmux verification map

This directory is the maintained source for verifying the user-facing behavior of the wmux desktop app. Read this index before driving, then use the matching feature file as the recipe. In every file, `control-wmux` means `node scripts/control-wmux.mjs`, run from the repo root.

## Baseline preconditions

- `npm ci` has run in this checkout (the driver uses the `playwright-core` dependency).
- One isolated instance is running: `control-wmux launch` printed `ok: true`. Never drive an instance this run did not launch; the driver refuses anyway.
- `control-wmux doctor` reports `healthy: true`. Note `checks.appVersion` vs `checks.repoVersion`: under skew, a handle missing live is skew, not drift.
- The baseline UI state, reached from a fresh launch in this order (each step only if present):
  1. Welcome wizard: `control-wmux click --testid first-run-wizard-skip`, then `control-wmux wait-settle --testid first-run-wizard --state hidden`.
  2. Onboarding tour (dialog "Every agent, one board", Step 1 / 4; it starts on the first Fleet visit): `control-wmux click --testid onboarding-skip`.
  3. "Keyboard shortcuts" card: `control-wmux click --testid keyboard-cheat-sheet-close`.
  4. Back on Workspaces: `control-wmux click --selector '[data-sidebar-nav="home"]'`.
- Baseline then means: one workspace "Workspace 1", one pane with one zsh tab, Settings closed, file tree hidden, the agent factory off.
- Recipes that need a known folder first `cd` the terminal into a scratch directory you created (see [terminal.md](./terminal.md)); never point the app at private files you would not want in evidence.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise. After a recipe, return to the baseline (Escape, close what you opened) or `stop` and relaunch.
- Handles, best first: `--testid`, then a stable `data-*` attribute via `--selector '[data-…]'`, then `--label` (aria-label) or `--role` + `--name`. Accessible names are English and change with the Language setting and with live state (rail buttons gain counts); `data-*` attributes do not.
- Treat every command as literal. Quote selectors with single quotes in the shell.
- One action per command, then `control-wmux wait-settle` (optionally on the element that should appear or disappear). No fixed sleeps.
- macOS shortcuts: a binding the code writes as `Ctrl+X` is `Meta+X` on macOS unless it is marked literal Ctrl (`src/shared/keymap.ts`). The tmux-style prefix is literal `Control+b` on every OS. Global shortcuts only fire on the Workspaces page.
- `eval`/`inspect` reads; it never sets state. The terminal output read-back through `window.__wmuxRunPaneSearch` is a read (it runs the same search the find bar runs).
- Do not drive anything a feature file lists as off-limits: those actions write outside the instance's data dir (`~/.claude/settings.json`, `~/.claude.json`, `~/.wmux/hooks/`, `~/.local/bin/wmux`, `gh` config), need accounts or a second PC, or start paid agents.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen: a `snapshot` of the changed region right after the action, and a `screenshot` when the claim is visual.
- Mutation proof includes a second, read-only view: an `inspect` read-back, a reopened panel, or the persisted file (`<userData>/session.json` for UI settings, where `<userData>` is the `userData` field `control-wmux doctor` or `launch` prints, never a hard-coded profile path; `~/.wmux<suffix>/` for daemon state).
- Every artifact lands in `.claude/skills/verify-wmux/evidence/<run-id>/`; cite the paths and the feature ID (for example `settings-theme`) in the verdict.
- When the screen is locked or the window hidden, `screenshot` may return `unavailable` or `suspectBlank`; say so and rely on the ARIA snapshot plus read-back.
- Report an unreachable path with the attempted command and the unmet precondition (`verified-unreachable: pc-switch, needs a paired second PC`).
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then exactly four H2s in this order:

1. `Sub-features`: short IDs with one line each.
2. `How to get to it (user POV)`: every user entry point (button, shortcut, menu, palette).
3. `Driving it with control-wmux`: starts with `Preconditions:`, then labeled bullets pairing each user action with an exact command and the observed result.
4. `Gotchas`: traps that waste or invalidate a run, including what must not be driven.

Name only user paths, stable handles, required state, commands and observable proof. When a handle changes in `src/renderer`, fix the file in the same change.

## Sweep order

One instance, driven serially, in this order (each leaves the baseline intact):

1. [First-run wizard, tour and cheat sheet](./first-run-wizard.md): reached first on every fresh launch.
2. [Sidebar and workspaces](./sidebar-workspaces.md)
3. [Panes and splits](./panes-splits.md)
4. [Terminal input and output](./terminal.md)
5. [File tree](./file-tree.md): needs the terminal `cd` from step 4.
6. [Browser panel](./browser-panel.md): needs network.
7. [Settings](./settings.md)
8. [Rail pages: Bots, Fleet, Schedules, Remote, Git](./rail-pages.md)
9. [Rooms (agent factory dock)](./rooms.md)
10. [PC switcher](./pc-switcher.md): absent-state check only, unless a second PC is paired.

Then `control-wmux stop --purge` and confirm the evidence directory is listed in its output.

## Features

- [first-run-wizard.md](./first-run-wizard.md): welcome wizard, onboarding tour, keyboard cheat sheet, reopening setup.
- [sidebar-workspaces.md](./sidebar-workspaces.md): workspace tree, create, switch, rename, close, sidebar toggle and resize.
- [panes-splits.md](./panes-splits.md): split right/down, zoom, stash, close tab with confirm, focus.
- [terminal.md](./terminal.md): typing into a pane, reading output back, find bar, font zoom.
- [file-tree.md](./file-tree.md): file tree column, root selection, open file into the viewer, filter.
- [browser-panel.md](./browser-panel.md): in-pane browser tab, toolbar, URL and title read-back.
- [settings.md](./settings.md): open/close, tabs, search, theme and language, persistence.
- [rail-pages.md](./rail-pages.md): Bots, Fleet, Schedules, Remote and Git pages and their empty states.
- [rooms.md](./rooms.md): the agent factory's room dock (threads, cards, questions, composer, HQ room) and Settings › Factory.
- [pc-switcher.md](./pc-switcher.md): switching the sidebar to another PC.
