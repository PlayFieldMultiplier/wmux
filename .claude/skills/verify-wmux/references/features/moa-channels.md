# Moa panel and channels

Moa is wmux's coordinating agent: once turned on it gets its own "Moa" workspace, a titlebar button and a right-side dock with its conversation and the task ledger. On desktop the right dock is Moa only; mission channels are read as Fleet task conversations. Moa is off on a fresh profile, and turning it on starts a real agent, so verification covers the off state and the turn-on path up to the confirm.

## Sub-features

- `moa-entry`: More › "Turn on Moa…" (only while Moa is off) opens Settings › Moa.
- `moa-settings`: Settings › Moa shows the "Moa" switch, Engine, Model, Effort and HQ status.
- `moa-turn-on-card`: the "Turn on Moa" card with confirm and "Not now".
- `moa-off-state`: no titlebar Moa button and no dock while off.
- `moa-dock`: (Moa on) titlebar button "Moa" toggles `[data-channel-dock]`.

## How to get to it (user POV)

- Rail "More" › "Turn on Moa…".
- Settings › Agents › "Moa".
- With Moa on: the titlebar "Moa" button; the sidebar Tasks line.
- No keyboard shortcut.

## Driving it with control-wmux

Preconditions:

- Baseline state, Moa off (fresh profile).

- **Entry from the menu.** Run `control-wmux click --label More`, then `control-wmux click --role menuitem --name "Turn on Moa…"`, then `control-wmux wait-settle --testid moa-tab`. Snapshot shows `heading "Moa"`, `switch "Moa"` (unchecked), `combobox "Engine"` ("Claude Code terminal" selected), `combobox "Model"`, `combobox "Effort"`.
- **Off state (second view).** Run `control-wmux inspect --js "({ titlebar: !!document.querySelector('[data-moa-titlebar]'), dock: !!document.querySelector('[data-channel-dock]'), hq: document.querySelector('[data-testid=moa-hq-status]')?.dataset.hqState ?? null })"`. Returns `titlebar: false, dock: false, hq: "unset"`, and `control-wmux inspect --js "document.querySelector('[role=switch][aria-label=Moa]')?.getAttribute('aria-checked')"` is `"false"`.
- **Turn-on card, then back out.** If the tab offers the turn-on card (`[data-testid="moa-first-run"]`, dialog "Turn on Moa"), snapshot it and dismiss with `control-wmux click --role button --name "Not now"` or `control-wmux press --key Escape`. Do not click `moa-first-run-confirm`.
- **Close.** `control-wmux press --key Escape` returns to Workspaces.

## Gotchas

- Turning Moa on (the switch, `moa-first-run-confirm`, "Turn on without Moa's workspace") starts the runtime and, with the default engine, the owner's real `claude` CLI (login, network, tokens). Treat every Moa-on flow as account-gated: report `verified-unreachable` with that prerequisite unless the run explicitly allows it.
- Moa's own state lives in `~/.wmux<suffix>/deck-hq.json` (isolated), but its brain uses the Claude Code hooks, which live in unsuffixed `~/.claude/` and `~/.wmux/hooks/`.
- `data-statusbar-channels` does not exist, and `[data-channel-dock-collapse]` belongs to a component that is not mounted; older dogfood scripts that use them are stale.
- "Turn on Moa…" disappears from the More menu once Moa is on.
