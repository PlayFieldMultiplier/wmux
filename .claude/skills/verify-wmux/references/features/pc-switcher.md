# PC switcher

When another PC is paired over the Tailnet, the sidebar title becomes a "Switch computer" dropdown (and the collapsed rail gets one icon) that points the sidebar and rail pages at that PC's workspaces. With only this computer there is nothing to switch, and the control is absent.

## Sub-features

- `pc-absent`: with no paired PC the title is plain text, no switcher, no rail item, and the Shift+Alt shortcuts stay with the pane.
- `pc-switch`: (paired) pick "This computer" or a paired PC; rail pages show "This computer · <name> isn't shown here yet" for the other PC.
- `pc-menu`: per-PC submenu "<name> settings": Mute notifications, Open Remote page, Pair again.
- `pc-shortcuts`: (paired) Shift+Alt+ArrowUp / ArrowDown / Home = previous / next / back to this computer.

## How to get to it (user POV)

- Sidebar title button "Switch computer" (only when a PC is paired).
- Collapsed rail item "Switch computer: <name>".
- Shift+Alt+ArrowUp / ArrowDown / Home.
- Pairing itself happens on the Remote page ("Connect a PC…"), which this map does not drive.

## Driving it with control-wmux

Preconditions:

- Baseline state on a single machine (the normal case for an isolated instance).

- **Absent state.** Run `control-wmux inspect --js "({ switcher: !!document.querySelector('[data-pc-switcher]'), rail: !!document.querySelector('[data-pc-switcher-rail]') })"`. Returns `{switcher: false, rail: false}`.
- **Proof.** `control-wmux snapshot --as pc-absent` shows the sidebar heading text "Workspaces" with no "Switch computer" button.
- **Switching.** Requires a second, paired PC: report `verified-unreachable: pc-switch, needs a second wmux PC paired over the Tailnet` unless the run provides one. With one: `control-wmux click --selector '[data-pc-switcher]'`, pick the PC by name, and confirm `[data-pc-switcher-name]` shows it.

## Gotchas

- Do not pair from a verification instance: "Connect a PC…" turns A2A on, creates an invite and writes the clipboard; "Pair again" starts a re-pair.
- control-wmux drives one instance at a time per checkout; proving switching needs a second paired PC and is out of scope for the driver today.
