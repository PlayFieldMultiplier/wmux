# F7: Config files and launch scripts

**Goal:** everything an operator needs to create, launch and relaunch the org's agents is written as reviewable templates, with no secrets, and every relaunch goes through one script per identity.

**Steps:**

1. Put templates in `config/org/` in the fork: org file, department files, launch templates.
2. Put the operator-local launcher at `C:\Users\victorb\.agents\wmux-org.ps1`, generated from its template, and keep the template in the fork.
3. Put one relaunch script per org agent in `C:\Users\victorb\.agents\`, following the naming already used there.
4. Put agent definitions in PFM (`.claude/agents/`) through the normal PR path, not in the fork.

## Current state (verified)

- `~/.agents/*.ps1` is the relaunch surface. Each script wraps `resume-agent.ps1`, which takes the model from the session JSONL unless `-Model` is passed, always adds `--dangerously-skip-permissions`, and supports `-DryRun` (`C:\Users\victorb\.claude\wmux-control.md`).
- A bare `claude --resume` is not used, because it does not pass the agent profile or the display name. Recorded in `wmux-control.md`.
- Never run two relaunches of the same identity at once. Check `Get-CimInstance Win32_Process -Filter "Name='claude.exe'"` first. A double-launch has happened before (`~/.agents/ao-wmux/AGENTS.md`).
- Workspace profiles set per-pane environment (`docs/workspace-profiles.md`). They apply to new panes only, so a profile change needs a new pane.
- `AS\MERIDIAN\BLUE\OTTOBOT\_` exists and is empty. `AS\WMUX\APP\_` does not exist.

## Gap

- No org launcher exists. No template exists in the fork.
- No single list of org agents with their launch script name and their identity.
- None on location: `AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_` is decided (L-09).

## Design

- **Templates are the source.** `config/org/launch/*.template` holds launch scripts with placeholders. The operator generates the local copy. Secrets never go in a template.
- **One identity, one script.** Each org agent has exactly one launch script, named after its identity, and the file is listed in `config/org/agents.json` with its department and its workspace.
- **Launch order.** The launcher sets `WMUX_DATA_SUFFIX` on the exe (F1), then starts the org instance, then relaunches agents one at a time, with a read-back after each.
- **Config dirs.** A per-agent `CLAUDE_CONFIG_DIR` goes in the workspace profile (`workspace-profiles.md`), not in the launch script, so a profile change is visible in one place.
- **Location.** The org's workspace subspace is `AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_` (decided, L-09).

## Folder changes (fork)

- `config/org/launch/wmux-org.ps1.template` (new).
- `config/org/agents.json` (new, no secrets).

## Folder changes (PFM and local)

- `C:\Users\victorb\.agents\wmux-org.ps1` (new, local, generated).
- `C:\Users\victorb\.agents\<identity>.ps1` for each org agent (new, local).
- `PFM___\.claude\agents\<identity>.md` for each org agent definition (new, through PR).

## Open decisions

- Whether the launch templates should live in the fork or in PFM (the fork is public).

## Verification

- `wmux-org.ps1 -DryRun` prints the resolved suffix and paths, and launches nothing.
- Every entry in `agents.json` has a launch script that exists on disk.

## Status

Designed. L-09 closed. Launch scripts still need the open decisions in L-10 and L-11.
