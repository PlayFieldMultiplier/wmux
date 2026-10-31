# Agent conventions (proposal, sprint 1)

Status: proposal. Each rule is marked PROPOSED or FROM-SOURCE. Victor approves before it binds.

## 1. Folders (starting folder)
- PROPOSED: every agent starts in the folder of the work it owns, never in the home folder.
- PROPOSED: the folder path names org, repo, kind (checkout or worktree) and branch when it is a git working folder.
- FROM-SOURCE: the office rule against recursive search in the home folder.

## 2. Launch parameters
- FROM-SOURCE: launch only through a launch script in `C:\Users\victorb\.agents`; never a bare `claude --resume`.
- FROM-SOURCE: the launch scripts pass the agent profile and display name. `resume-agent.ps1` reads `--agent` and `-n` from the session transcript, and always adds `--dangerously-skip-permissions`.
- PROPOSED: record the model per agent in the registry; do not rely on the session's last model.

## 3. Agent profiles
- PROPOSED: one profile per agent class, in `.claude/agents/<name>.md`, holding identity, scope and rules. Operating lessons for wmux go in the profile of the class that owns wmux.
- FROM-SOURCE: a profile's `tools:` frontmatter restricts what the session can call.

## 4. Shared context
- PROPOSED: shared facts live in one file per topic, with a date and evidence. Agents cite the file, not chat.
- PROPOSED: a live roster (who is running) is never stored in a shared file. It is read at the moment of use.

## 5. Team assignments
- PROPOSED: one feature owner per concern. The owner holds the concern's ledger rows.
- FROM-SOURCE: Victor assigns feature owners (feature-owner memory note). PROPOSED: an agent does not assign itself a new concern; this half has no source yet.

## 6. Responsibilities
- PROPOSED: an owner is accountable for its concern's state, including its open items, until it hands them off with evidence.
- FROM-SOURCE: logins and Remote Control belong to rabbit agents; wmux fabric belongs to AO_WMUX.

## 7. Communication
- FROM-SOURCE: send to a live agent by a task (`a2a_task_send`) or by typing into its PTY after reading the pane and confirming its input is empty; then send Enter as a separate key and read back.
- PROPOSED: do not report a message as pending when its target was not running (this is the rule from the 2026-10-30 operating manual, not yet in a wmux rule file).
- PROPOSED: a handoff names the next owner, the evidence, and the open items.
