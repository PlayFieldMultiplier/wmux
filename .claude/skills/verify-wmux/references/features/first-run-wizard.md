# First-run wizard, onboarding tour and cheat sheet

A fresh profile opens the "Welcome to wmux" wizard (Claude Code detection, MCP registration, hooks, statusline, auto-update, a sample task), then offers a spotlight tour on the first Fleet visit and a "Keyboard shortcuts" card. The wizard can be reopened from Settings › General. Completion is recorded per profile, so every new `WMUX_DATA_SUFFIX` sees it again.

## Sub-features

- `frw-show`: wizard opens on boot when `<userData>/.first-run` is missing.
- `frw-status`: rows show Claude Code detected / MCP registered / hooks / statusline state (read-only probes).
- `frw-dismiss`: "Skip for now", the Close button or Escape closes it and records completion.
- `frw-reopen`: Settings › General › "Open setup wizard" reopens it in reopen mode (no auto-update row, sample task disabled).
- `tour`: 4-step onboarding tour ("Every agent, one board", Step 1 / 4) with Skip / Back / Next.
- `cheatsheet`: "Keyboard shortcuts" card with "Dismiss" and "Don't show again".

## How to get to it (user POV)

- Launch wmux with a profile that has never completed setup.
- Settings › General › First-run setup › "Open setup wizard" / "Show keyboard cheat sheet".
- Settings › General › Tutorial › "Restart Tutorial" (tour).
- Prefix `Ctrl+B` then `?` shows the cheat sheet.
- The tour also starts by itself on the first Fleet visit of a fresh profile.

## Driving it with control-wmux

Preconditions:

- A just-launched instance (fresh suffix); `control-wmux doctor` shows `checks.ui.firstRunWizard: true`.

- **Wizard shows.** Run `control-wmux snapshot --testid first-run-wizard --as wizard`. The snapshot has `dialog "Welcome to wmux"` with "Claude Code detected" (or not), "Try sample task" and "Skip for now".
- **Dismiss.** Run `control-wmux click --testid first-run-wizard-skip`, then `control-wmux wait-settle --testid first-run-wizard --state hidden`. `settled: true`; a following `doctor` shows `firstRunWizard: false`.
- **Completion recorded (second view).** Run `control-wmux press --key Meta+Comma`, then `control-wmux wait-settle --testid first-run-setup-last-completed`, then `control-wmux inspect --js "document.querySelector('[data-testid=first-run-setup-last-completed]')?.textContent"`. Text starts with `Last completed: <today>`.
- **Reopen.** Run `control-wmux click --testid first-run-setup-open-wizard`, then `control-wmux wait-settle --testid first-run-wizard`. The wizard is back; `control-wmux inspect --js "!!document.querySelector('[data-testid=first-run-wizard-auto-update-switch]')"` returns `false` in reopen mode. Close with `control-wmux click --testid first-run-wizard-close`.
- **Tour.** Run `control-wmux click --selector '[data-sidebar-nav="fleet"]'`, then `control-wmux wait-settle --testid onboarding-card`. A dialog "Every agent, one board" with "Step 1 / 4". `control-wmux click --testid onboarding-next` advances; `control-wmux click --testid onboarding-skip` ends it and the card disappears.
- **Cheat sheet.** After the tour, `control-wmux wait-settle --testid keyboard-cheat-sheet --quiet 0`, then `control-wmux snapshot --testid keyboard-cheat-sheet --as cheatsheet` lists shortcuts ("Split horizontal ⌘D", "Open settings ⌘,", ...). `control-wmux click --testid keyboard-cheat-sheet-close` removes it.

## Gotchas

- Never click `first-run-wizard-hooks-install` or `first-run-wizard-statusline-install`: both write the owner's real `~/.claude/settings.json` and `~/.wmux/hooks/` (no suffix). The same applies to `[data-hooks-install]` in the deck's hooks prompt; dismiss that with `[data-hooks-later]`.
- Never click `first-run-wizard-try`: it splits the workspace 2x2 and launches the real `claude` CLI (account, network) in a pane; the layout is not rolled back.
- `first-run-wizard-register` writes nothing under a suffix (it returns ok without touching `~/.claude.json`), so its row may stay "not registered"; do not assert that it flips.
- The Claude Code / MCP / hooks rows read the owner's real `~/.claude*` files, so their state reflects the machine, not the isolated profile.
- The backdrop does not close the wizard; use Skip, Close or Escape. The install link opens the system browser.
- A modal tour blocks clicks elsewhere: a `click` fails with `onboarding-backdrop ... intercepts pointer events` until you skip it.
- The cheat sheet hides itself after about 30 s and animates a progress bar meanwhile, so the DOM never goes quiet: use `wait-settle ... --quiet 0` while it is up, and snapshot it promptly.
- Settings content renders a moment after the page opens; `wait-settle` on the test id before reading it.
