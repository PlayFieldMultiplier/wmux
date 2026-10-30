# Upstream company-feature survey (read-only, as of 2026-10-29)

Source: `openwong2kim/wmux` through `gh api`. Nothing was cloned or installed.

## Commit activity touching company paths

Paths read: `src/company`, `src/main/company`, `src/main/pipe/handlers/company.rpc.ts`. The commit API returns at most 100 per path, and these lists are complete for the paths shown.

| Month | Commits | Character |
|---|---|---|
| 2026-04 | 18 | Build-out burst. Includes a merge restore that left duplicate files. |
| 2026-05 | 3 | Fixes: A2A sender authorisation, SOUL prompt loading |
| 2026-06 | 5 | Fixes and small refactors |
| 2026-07 | 4 | i18n routing, design tokens |
| 2026-08 | 1 | Stash a pane out of the layout |
| 2026-09 | 4 | Removals and gated delivery |
| 2026-10 | 3 | Removal of duplicate files; Moa hand-off change |

Only April is feature work. The rest is fixes, removals and pass-through changes.

## Notable changes

- **PR #1165**, closed and merged 2026-09-02: removed the six `company_a2a_*` MCP tools and the standalone server `src/company/mcp/index.ts`. The PR's own table shows that department-name routing, the member inbox and the department tree have no replacement. Rationale given: no prompt, skill or documented flow called them.
- **PR #2134**, closed 2026-10-12: removed 21 unreachable duplicate company-mode files (4,383 lines). It removed `src/company/main/company.rpc.ts` and `src/main/company/*` in favour of `src/main/pipe/handlers/company.rpc.ts` and `src/renderer/components/Company/*`. It also deliberately kept `src/renderer/channels/LocalPtyDelivery.ts` and `src/daemon/lanlink/deliver.ts`.
- **PR #1796**, merged 2026-10-05: Moa hand-offs now need operator approval instead of pasted A2A envelopes.
- **PR #1560**, merged 2026-09: non-operator pane deliveries go through one gated submit.
- **PR #1389 and #1470**, merged 2026-09: A2A nudges into Codex panes, and newline handling for agent TUI receivers.
- **PR #1866, #1949, #2530 to #2534**, 2026-10: a2a-remote pairing, pinned TLS, and pane sharing between PCs.

## Issues

- Keyword search `repo:openwong2kim/wmux is:issue company` returns 0 open and 10 closed. The backlog for company mode is effectively empty.
- Titles that contain "company" are mostly PRs that match in their body, so the keyword count is noisy. The commit history above is the more reliable signal.

## Documented direction

- `docs/api/inventory.md` line 146: company mode is "experimental", and it is being re-evaluated at the post-v3.0 gate "as a first-party reference orchestrator on top of the substrate, not a core wmux feature".
- `ARCHITECTURE.md` line 132: "Multi-agent org: CEO -> departments -> members".

## Reading

1. **Likely to keep changing?** Slowly, and mostly by removal. There is no open company work. Expect further pruning, not a rebuild.
2. **Direction fits our needs?** No, at the company level. Upstream is removing department-scoped routing and the member inbox, and adding operator approval gates on agent messaging. Our design needs the opposite.
3. **Recommendation:** extend from the locked point in our own fork. Keep the 3.38.1 company code as our starting point, and do not plan regular cherry-picks of company code from upstream. Track upstream for security fixes and for the agent-messaging work, and review each diff by hand.
