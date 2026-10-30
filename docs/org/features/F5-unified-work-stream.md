# F5: Unified work stream (company-level "who needs to do what next")

**Plain meaning.** One shared list of work items for the whole org, with one entry per piece of work. Each entry says what it is, which department owns it, whether it is open, blocked or done, and, for done, the evidence that it is done. Every department reads from and writes to this one list. The list is the company-wide answer to "who needs to do what next, and what has already been finished." It is not a chat, not a channel, and not the GitHub Projects board used for LeagueOS product work.

**Example entry:** `{id: ORG-0007, department: WMUX, owner: AO_WMUX, title: "Write F4 read of 4.x gates", state: open, blockedBy: none}`. When it is finished, the owner changes `state` to `done` and attaches the evidence, such as a file path and commit.

**Goal:** the whole org reads one ordered stream of work items: what is open, who owns it, what is blocked, what is done and with what evidence. Every department writes to it and reads from it. No department keeps its own separate list as the source of truth.

**Steps:**

1. Define the item schema (below) in `src/org/stream/schema.ts`.
2. Store items in one append-only log, with a derived view for each department.
3. Expose read and write through the existing channel tool surface, so no new transport is needed.
4. Require every status change to carry evidence.

## Current state (verified)

- wmux has channels with `channel_post`, `channel_read`, `channel_unread` and `channel_ack`, and a `channel_mission_start` and `channel_mission_close` pair (verified in the tool list and in `docs/api/inventory.md`).
- `channel_post` is a notification, not delivery. An idle agent does not see it until it polls. Verified in the coordinator notes, and in `wmux-control.md`.
- Upstream channels were extended in 2026-06 (PR #305, "Slack-for-agents"). Our base has them.
- PFM already keeps work items in GitHub Projects, and the PM agent treats Project 7 as the live LeagueOS authority (PFM `AGENTS.md`). The org stream must not compete with that for the LeagueOS work. It is for the org's own operating work.

## Gap

- No single stream exists for org work across departments.
- Channels are notifications, so a stream built on them needs a polling or wake rule, or items will sit unread.
- No evidence rule. Done today means "someone said so".

## Design

- **Item.** `{id, department, owner, title, state: open|blocked|done|dropped, blockedBy?, evidence?, updatedAt, updatedBy}`. `done` requires `evidence` (a path, a PR URL, or a command result). Without it the state change is refused.
- **Log.** One append-only file per org instance, `stream.jsonl`, under `~/.wmux-pfm/stream/`. Writes are atomic. Each line carries the writer's identity.
- **Views.** A department view is the log filtered by `department`. The coordination workspace (ORG/COORDINATION) shows all departments.
- **Wake rule.** A new item addressed to an owner is delivered with `send_message` or `a2a_task_send` to that owner's resolved surface, then read back. A channel post alone is not enough (F3).
- **Source relation.** For LeagueOS work, an item links to a GitHub issue URL and does not duplicate its state.

## Folder changes (fork)

- `src/org/stream/` (new): `schema.ts`, `log.ts`, `view.ts`, `wake.ts`, with tests.
- `~/.wmux-pfm/stream/stream.jsonl` at runtime (not in the repo).

## Open decisions

- Whether the stream lives in the org instance only, or is also mirrored to a GitHub Project (LEDGER L-08).

## Verification

- Write one item from each of two departments. Read the coordination view from one, and see both.
- Mark an item `done` without evidence. The write is refused.
- Mark an item `done` with evidence. The owner reads it back.

## Status

Designed. Not built.
