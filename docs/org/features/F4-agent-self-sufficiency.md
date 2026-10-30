# F4: Agent self-sufficiency (no gates on an agent's own panes)

**Goal:** an agent can create, split, name and rename its own panes and surfaces, and can launch another pane, without a configuration step or an approval gate, in every org workspace. Where wmux or Claude Code forces a gate, the org fork removes it or documents why it cannot.

**Steps:**

1. Read the actual gate code in the 4.13 tree before deciding what to strip (this has not been done; see Gap).
2. Confirm in 3.38.1 that no equivalent gate exists, using the source, not inference.
3. Write down each gate, its source file, and its owner.
4. Remove or bypass each gate in `src/org/` where it is ours to change, and document each one that is not.

## Current state (verified in the 3.38.1 source, by search only)

- Search of `src/main`, `src/daemon` and `src/cli` for permission or gate checks on `surface_new`, `pane_split` or `surface.create` returned no matches. This is a search result, not a full read.
- Agents do have `mcp__wmux__pane_split`, `mcp__wmux__surface_new`, `mcp__wmux__pane_set_metadata` and `mcp__wmux__pane_close` in their tool lists (verified in the session tool list).
- `pane_split` has no pane target. It splits the focused pane (`wmux-control.md`).
- The pane-close tool rejects branch panes and the root pane (`wmux-control.md`).
- `src/main/deck/ClaudePtyBrainAdapter.ts` line 297 tells a brain with no shell to "Split a worker pane (`mcp__wmux__pane_split`)", so splitting is an intended agent action in 3.38.1.
- Upstream 4.x is reported by Victor to add permission gating on agents naming their own surfaces and panes, and an extra config step before launching panes. **Not verified.** The 4.13 blobs have not been read.
- Upstream `docs/api/inventory.md` and PR #1560 show a gated submit for non-operator pane deliveries in the later line. That is delivery, not pane creation. It is relevant, and it is unverified for our base.

## Gap

- The 4.x gates are described by Victor, not by source. We cannot strip what we have not read.
- No org-level policy says which actions an agent may take on its own panes.

## Design

- **Read first.** Read the 4.13 files for pane and surface creation, naming and launch config, and record each gate with path and line in `research/` (a new file, `4x-gates.md`).
- **Policy.** In the org fork, an agent may create, split, close and name its own panes and surfaces, subject only to the scope rule in F3 (no touching another department's panes). No approval step.
- **Guard rails that stay.** Focus before implicit-target mutation (`pane_focus` first). Confirm the target with `pane_list` after a close. These are about correctness, not permission.
- **Launch.** A pane launch needs no config file. If upstream adds one, the org fork supplies a default that makes the step a no-op.

## Folder changes (fork)

- `docs/org/research/4x-gates.md` (new, after the 4.13 read).
- `src/org/instance/policy.ts` (new): the self-sufficiency policy, read by any code that creates panes.

## Open decisions

- Whether any 4.x gate protects against a real risk we should keep (for example, an agent closing another agent's pane). Victor to decide after the read.

## Verification

- An agent in the org instance splits its own pane, names it, closes it, with no approval prompt and no config change.
- The same actions against another department's pane are refused by the F3 scope rule.

## Status

Designed. The 4.x read is not done (LEDGER L-06).
