# UPSTREAM-WATCH for openwong2kim/wmux

Target: L-24 (W3 upstream). Read-only. Dated entries. Nothing here changes upstream or the fork.

Product: wmux, whose website is wmux.app. This is `openwong2kim/wmux`, not wmux.org (a different, unvalidated product).

## Entry 2026-10-30T13:36Z

Query: `gh api repos/openwong2kim/wmux` and `gh api repos/openwong2kim/wmux/releases/latest`, `.../tags`, and `search/issues` with `repo:openwong2kim/wmux`, run by AO_WMUX.

| Fact | Value | Query |
|---|---|---|
| Latest release | `v4.13.0` | releases/latest |
| Latest tag | `v4.13.0` | tags, first entry |
| Default branch | `main` | repo |
| Open issues (GitHub count, includes PRs) | 14 | repo.open_issues_count |
| Open pull requests | 6 | search is:pr is:open |
| Open issues mentioning "company" | 0 | search is:issue is:open company |
| Open pull requests mentioning "company" | 1 | search is:pr is:open company |

What this means for the fork:

- The fleet is locked to `v3.38.1`. The latest release, `v4.13.0`, is what upstream ships now. The lock is not changed by this entry.
- Company-mode activity upstream is low: no open company issues, one open company PR. That PR is not read in this entry. Reading it is the next watch item.
- Upstream removed the `company_a2a_*` MCP tools in PR 1165 (2026-09-02). The fork keeps them (BEHAVIOUR-3.38.1 B14, DIGEST).

Not checked in this entry: the content of the open PRs and issues, release notes for v3.39 through v4.13, the company PR's diff.

## Next watch items

1. Read the one open company PR and record its number, title and state.
2. Read the release notes for v4.13.0 and record anything touching the pane or surface gates (RESEARCH-DIGEST UNVERIFIED item, L-06).

## Entry 2026-10-30T16:30Z

Query: `gh api search/issues` and `gh pr view` against `openwong2kim/wmux`, read-only, run by AO_WMUX.

| Fact | Value | Change since entry 1 |
|---|---|---|
| Latest release | `v4.13.0` | none |
| Open pull requests | 7 | up from 6 |
| Open pull requests mentioning "company" | 1: #2888 "feat(company): show a company's seats and work on a board tab" (updated 2026-10-30T16:27:47Z) | was 1 (#2886), now a different PR |
| Open issues mentioning "company" | 0 | none |
| PR #2886 "feat(company): make a workspace a company, and show it in the sidebar" | merged, merge commit `57a7a1fcf` | merged at 14:24Z |

What this means for the fork:

- Company-mode work upstream is active again: #2886 merged and #2888 is open, adding a board tab. The fork's design set (F2 org model) should read #2888 when it is merged or changes state.
- The fleet lock stays at v3.38.1. None of this changes it.
- #2888 is not read in this entry (its content is the next watch item).

Next watch items:

1. Read #2888 when it changes state, and record its files and whether it touches `src/company/`.
2. Keep the count of open company issues (0 at both entries).
