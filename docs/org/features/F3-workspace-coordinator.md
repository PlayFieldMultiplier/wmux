# F3: Per-workspace coordinator

**Goal:** every department workspace has one coordinator agent that owns that department's queue, routes work to its members, and reports status upward to the company stream (F5). The coordinator is a role with written authority, not a special wmux object.

**Steps:**

1. Write the coordinator role definition for each department, as an agent definition file, and link it from `org.json` (F2).
2. Give each coordinator read access to its department's members (their surfaces and status) through the existing `surface_list` and `pane_list` tools.
3. Give each coordinator write access to its own department's queue only, and to the company stream (F5) for status updates.
4. Require every coordinator to check the stream and read its members' panes before routing any new work.

## Current state (verified)

- 3.38.1 has no coordinator object. The upstream "coordinator" in the 3.x-era discussion was a feature of the `main` branch (`src/main/factory/roles/coordinator.ts`) that is not in 3.38.1. Do not use that name for the org role without saying so.
- `pane_split` has no pane target. It splits the focused pane, so a coordinator must focus its own pane first (`C:\Users\victorb\.claude\wmux-control.md`).
- The MERIDIAN fleet already runs with a coordinator-like role: `hazrat-rabbit` and `meridian` are dispatch agents (`C:\Users\victorb\.claude\agents\hazrat-rabbit.md`). Their authority is written in their own definitions, not in wmux.
- wmux's channel and A2A tools deliver messages to idle agents only through `send_message` or `a2a_task_send`, and a pane-level `terminal_send` needs a separate Enter key. This is verified in `wmux-control.md`.

## Gap

- No written coordinator definition exists per department.
- No rule says what a coordinator may do to another department's members. Without one, a coordinator can route anyone's work, which is the failure we want to avoid.
- Coordinators have no common status format yet (F5 defines it).

## Design

- **Authority is written, not coded.** The coordinator's definition is a markdown file, `src/org/coordinator/roles/<dept>.md`, loaded as the agent definition. It states: the department, its members, what it may assign, what it must report, what it must never do.
- **Scope rule.** A coordinator assigns work inside its own department. Cross-department work goes through the other department's coordinator, by stream message, never by typing into another department's pane.
- **Self-sufficiency rule.** Coordinators do not wait for approval to route work inside their own department. They wait only for the explicit decisions listed in the org model (F2).
- **Liveness.** Before routing, a coordinator checks each member's `agentStatus` through `surface_list`, not `pane_list` alone, since one pane can hold several surfaces.

## Folder changes (fork)

- `src/org/coordinator/roles/` (new): one markdown definition per department, plus a shared `COORDINATOR-BASE.md`.

## Open decisions

- Which agent coordinates each department (LEDGER L-10).
- Whether a coordinator can be a fleet agent that also keeps its existing role, or must be a dedicated one.

## Verification

- For each department, the coordinator reads its own members' statuses and lists them, without typing into any pane.
- A test message from one department's coordinator to another department's coordinator arrives through the stream and is read back, with the Enter key sent separately.

## Status

Designed. Not built. No coordinator has been assigned.
