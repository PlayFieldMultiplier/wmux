# PlayFieldMultiplier wmux fork: design set

**Start here.** You do not need any prior conversation to use this set. Read in this order:

1. `README.md` (this file): what the fork is and where everything lives.
2. `research/RESEARCH-DIGEST.md`: every verified fact so far, with the file path or URL it came from.
3. `research/UPSTREAM-COMPANY-SURVEY.md`: upstream activity on the company feature, with the numbers.
4. `FOLDER-STRUCTURE.md`: the full target layout of the fork and of the local workspace.
5. `LEDGER.md`: every commitment, with its status and evidence. Read before acting. Anything marked open is not done.
6. `features/F0` to `features/F7`: one design doc per feature. Read the ones relevant to your task.

## What this fork is

- **Repository:** `PlayFieldMultiplier/wmux`, a fork of `openwong2kim/wmux` (MIT). Public, because GitHub cannot make a fork of a public repository private.
- **Default branch:** `org/base-3.38.1`. This is the upstream tag `v3.38.1` at commit `245ba5e80a1f97eb20f2f2497b39209a8a94f7ba`. It is the fork point, and it is the version this org modifies.
- **Upstream `main`:** present in the fork as a reference only. Do not base org work on it. It is the 4.x line that this org has decided against.
- **Design branch:** `docs/org-design-v0`, opened as a PR against `org/base-3.38.1`.

## Why it exists

Victor's direction, 2026-10-29:

- Agents must be self-sufficient. The 4.x line adds gates on agents creating and naming their own panes and surfaces, and a config step before panes can be launched. Those are rejected.
- The org needs a company-level structure: one workspace per department or office, each with a coordinator, and one unified stream of who needs to do what next.
- Upstream company-mode development is in maintenance and removal mode (see `research/UPSTREAM-COMPANY-SURVEY.md`). The org therefore owns its own company layer, starting from the 3.38.1 code, and does not track upstream for it.

## Working rules for everyone touching this set

- **Verify before you assert.** Every fact in `research/` cites a path or URL. A claim without a citation is a hypothesis, and must be labelled as one.
- **Do not change the installed build.** The installed wmux is still the upstream release. This fork is built and run separately.
- **Do not use the wmux browser tool.** It splits the active pane. The standing rule is in `C:\Users\victorb\.claude\wmux-agents.md`.
- **Changes go through a branch and PR.** Merge only after an independent review of the exact head.
- **Every "I will" goes in `LEDGER.md` in the same turn**, with a status and an evidence column.
