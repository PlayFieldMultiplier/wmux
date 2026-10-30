# F0: Fork governance

**Goal (what must be true):** the org's wmux fork is the one version the org modifies. Its base is known, its upstream relationship is explicit, and no agent builds on a version it has not chosen.

**Steps (what to do):**

1. Keep `org/base-3.38.1` as the default branch, at tag `v3.38.1`, commit `245ba5e8`.
2. Name the base in every PR and in every feature doc.
3. Sync from upstream only by reviewed cherry-pick of named commits. Record each pick in `LEDGER.md`.
4. Keep the upstream `main` branch in the fork as a reference, and never base org work on it.
5. Update the fleet lock text in `C:\.______\.KADMON\.WMUX__\AGENTS.md` and in `PFM___\.claude\agents\ao-wmux.md` to name the fork. Do this by PR, after Victor approves the wording.

## Current state (verified)

- The fork exists: `PlayFieldMultiplier/wmux`, parent `openwong2kim/wmux`, public.
- The default branch is `org/base-3.38.1`, created at the tag commit. Verified with `gh api repos/PlayFieldMultiplier/wmux`.
- The fleet lock still says 3.38.1 as the installed and fleet version, and it does not yet name the fork.

## Gap

- The lock text describes the installed upstream build. It does not describe this fork, so an agent reading it would think the fork is not the target.
- No rule yet says how upstream fixes get into the fork.

## Design

- **Two versions, one owner.** The installed upstream build stays as the release we run in production until the fork is ready. The fork becomes the target after its first verified run. The switch is a separate decision, recorded in `LEDGER.md`.
- **Sync rule.** Security fixes: pick within one week of upstream publication, after review. Feature changes: do not pick unless a feature doc asks for them.
- **Visibility.** A fork of a public repository cannot be made private. Anything that must stay private (credentials, org-specific config) lives outside the repository, under `config/org/` only as templates with placeholders.

## Folder changes

- None in the fork beyond `docs/org/`.
- The PFM lock change touches only `.claude/agents/ao-wmux.md` and `AGENTS.md` (the `.WMUX__` tier).

## Open decisions

- L-07: wording of the lock change.
- Whether the fork becomes the installed build, and when.

## Verification

- `gh api repos/PlayFieldMultiplier/wmux --jq .default_branch` returns `org/base-3.38.1`.
- `git -C "C:\.______\.KADMON\.WMUX__\src\PlayFieldMultiplier\wmux\checkout\docs-org-design-v0" describe --tags` returns `v3.38.1` on the base branch.

## Status

Partly done. The fork and base branch are in place. The lock update is open (L-07).
