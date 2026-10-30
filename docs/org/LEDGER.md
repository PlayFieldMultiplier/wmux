# Ledger: commitments, status, evidence

Read this before acting. A row with status `open` is not done. Close a row only with the evidence column filled in.

| ID | Commitment | Owner | Status | Evidence |
|---|---|---|---|---|
| L-01 | Fork `openwong2kim/wmux` into `PlayFieldMultiplier` | AO_WMUX (acting account `DarienSirius`) | done | `gh api repos/PlayFieldMultiplier/wmux` returns `fork: true`, `parent: openwong2kim/wmux`. Created 2026-10-29. Visibility is public (forks of public repositories cannot be private). |
| L-02 | Base branch at the locked tag | AO_WMUX | done | Branch `org/base-3.38.1` at `245ba5e80a1f97eb20f2f2497b39209a8a94f7ba`, which is tag `v3.38.1`. Set as default branch. |
| L-03 | Clone the fork into `.WMUX__\src\wmux-org` | AO_WMUX | done | Clone exists; `git describe --tags` returns `v3.38.1` on `docs/org-design-v0`. |
| L-04 | Write the design set (README, research, folder structure, F0–F7) | AO_WMUX | done in working tree | Files under `docs/org/` in the clone. Not yet committed or pushed (see L-12). |
| L-05 | Launch an isolated org instance and verify isolation | AO_WMUX, after Victor's approval | open | Blocked on approval. Evidence to collect: log line, hash of production `session.json` before and after, paths under `~/.wmux-org`. |
| L-06 | Read the 4.13 pane, surface and launch-config gates; record in `research/4x-gates.md` | AO_WMUX | open | Not started. Evidence: the file with path and line for each gate. |
| L-07 | Update the fleet lock in `AGENTS.md` (`.WMUX__`) and `ao-wmux.md` (PFM) to name the fork | AO_WMUX, after Victor approves wording | open | Requires Victor's approval of the text. PFM change goes through PR and `pfm-merge.sh`. |
| L-08 | Decide where the unified stream lives (instance only, or mirrored to a GitHub Project) | Victor | open | Decision needed. |
| L-09 | Decide the parent of `AS/WMUX/APP/_` | Victor | open | Decision needed. `AS/MERIDIAN/BLUE/OTTOBOT/_` exists and is empty. |
| L-10 | Decide the department list and each department's coordinator | Victor, with Meridian | open | Decision needed. Placeholders in FOLDER-STRUCTURE.md. |
| L-11 | Decide whether the org has its own accounts or shares MERIDIAN's | Victor | open | Decision needed. Affects F6. |
| L-12 | Commit, push and open a PR for `docs/org-design-v0` against `org/base-3.38.1` | AO_WMUX | open (next step) | Evidence: PR URL and an independent review of the exact head. |
| L-13 | Verify the self-contained claim: an agent with no prior context can use the set | AO_WMUX | open | Evidence: a fresh agent reads only `docs/org/README.md` and reports what it cannot find. |

## Notes

- Victor's standing order (2026-10-29): every "I will" goes in this file in the same turn, with a status and an evidence column. A row marked `done` needs the evidence written here.
- The acting account for the fork was `DarienSirius`. The office procedure prefers `ottopoet-thesean` for OPT work and allows `DarienSirius` only for a demonstrated missing permission. This is recorded as an attribution note, not as a fix.
