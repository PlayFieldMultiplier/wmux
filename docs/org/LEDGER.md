# Ledger: commitments, status, evidence

Read this before acting. A row with status `open` is not done. Close a row only with the evidence column filled in.

| ID | Commitment | Owner | Status | Evidence |
|---|---|---|---|---|
| L-01 | Fork `openwong2kim/wmux` into `PlayFieldMultiplier` | AO_WMUX (acting account `DarienSirius`) | done | `gh api repos/PlayFieldMultiplier/wmux` returns `fork: true`, `parent: openwong2kim/wmux`. Created 2026-10-29. Visibility is public (forks of public repositories cannot be private). |
| L-02 | Base branch at the locked tag | AO_WMUX | done | Branch `org/base-3.38.1` at `245ba5e80a1f97eb20f2f2497b39209a8a94f7ba`, which is tag `v3.38.1`. Set as default branch. |
| L-03 | Clone the fork into `.WMUX__\src\wmux-org` | AO_WMUX | done | Clone exists; `git describe --tags` returns `v3.38.1` on `docs/org-design-v0`. |
| L-04 | Write the design set (README, research, folder structure, F0–F7) | AO_WMUX | done | Committed as 387dd4ba3 on `docs/org-design-v0` and pushed. See L-12 for the PR. |
| L-05 | Launch an isolated org instance and verify isolation | AO_WMUX, after Victor's approval | open | Blocked on approval. Evidence to collect: log line, hash of production `session.json` before and after, paths under `~/.wmux-org`. |
| L-06 | Read the 4.13 pane, surface and launch-config gates; record in `research/4x-gates.md` | AO_WMUX | open | Not started. Evidence: the file with path and line for each gate. |
| L-07 | Update the fleet lock in `AGENTS.md` (`.WMUX__`) and `ao-wmux.md` (PFM) to name the fork | AO_WMUX, after Victor approves wording | open | Requires Victor's approval of the text. PFM change goes through PR and `pfm-merge.sh`. |
| L-08 | Decide whether the org-wide work list (F5, the "unified stream": one shared list of work items with owner, state and evidence) is kept only in the org instance, or also mirrored to a GitHub Project | Victor | open | Decision needed. |
| L-09 | Place `AS/WMUX/APP/_` under `AS/MERIDIAN/BLUE/OTTOBOT/_` | Victor (instruction), AO_WMUX (action) | done | Folder created: `C:\.______\.KADMON\PLAY__\FIELD_\MULTI_\PLIER_\_\AS\MERIDIAN\BLUE\OTTOBOT\_\AS\WMUX\APP\_`, created 2026-10-29, empty. |
| L-10 | Decide the department list and each department's coordinator | Victor, with Meridian | open | Decision needed. Placeholders in FOLDER-STRUCTURE.md. |
| L-11 | Decide which Claude Code logins (accounts: subscriptions with their own quota and Remote Control session) the org's agents run under. Option A: reuse MERIDIAN's logins, so the org shares quota, and one credential write disconnects both. Option B: separate logins, so the org has its own quota and its own login dances. | Victor | open | Decision needed. Affects F6. |
| L-12 | Commit, push and open a PR for `docs/org-design-v0` against `org/base-3.38.1` | AO_WMUX | done: PR open, review pending | PR https://github.com/PlayFieldMultiplier/wmux/pull/1 (commit 387dd4ba3). Independent review of the exact head still needed before merge. |
| L-14 | Ask MERIDIAN_BLUE (surface title "MERIDIAN_BLUE", ptyId daemon-25a07915) for the current org chart: coordinator, members, and workspace or pane per department | AO_WMUX | done | Request sent 2026-10-29 by terminal_send, then Enter as a separate key; pane read back showed the text and a new turn. Reply received in Blue's pane starting "ORG CHART:". Recorded in `docs/org/research/MERIDIAN-ORG-CHART-2026-10-29.md`. All ptyIds and pane IDs re-checked against `surface_list` the same day; all match. Unverified cards: ANSCOMBE, GALILEO, AO_WSL, AO_WMUX. |
| L-13 | Verify the self-contained claim: an agent with no prior context can use the set | AO_WMUX | open | Evidence: a fresh agent reads only `docs/org/README.md` and reports what it cannot find. |

## Notes

- Victor's standing order (2026-10-29): every "I will" goes in this file in the same turn, with a status and an evidence column. A row marked `done` needs the evidence written here.
- The acting account for the fork was `DarienSirius`. The office procedure prefers `ottopoet-thesean` for OPT work and allows `DarienSirius` only for a demonstrated missing permission. This is recorded as an attribution note, not as a fix.
