# Factory behaviour scenarios

End-to-end checks of the agent factory (bots, wakes, rooms, handoffs, the
merge lane) against an isolated instance of this checkout's build. Each
scenario is one JSON file here; `scripts/factory-smoke.mjs` runs it and
`scripts/factory-graders/` scores what happened.

## Run

```sh
npm run package                       # or any build that fills .vite/build and dist/mcp-bundle
node scripts/factory-smoke.mjs --list
node scripts/factory-smoke.mjs --scenario reply-in-wake-thread
node scripts/factory-smoke.mjs --all --layer regression              # stub scenarios, 1 run each
node scripts/factory-smoke.mjs --all --layer workflow                # stub scenarios, 3 runs each
node scripts/factory-smoke.mjs --scenario moa-morning-report-real --runs 1 --allow-real
node scripts/factory-smoke.mjs --grade <evidence.json>               # re-score a saved snapshot
```

Results land in `.claude/skills/verify-wmux/evidence/factory-smoke-<time>/`
(git-ignored): `results.md` (the table), and per run `evidence.json` (the
snapshot) and `grade.json`. Set `FACTORY_SMOKE_KEEP_TMP=1` to keep the run's
temp dir (stub scripts and logs, the scratch repo).

Runs are sequential: `control-wmux` drives one instance per checkout. A run
takes 10–30 s; the lane and repo-watch scenarios take 2–4 min (the repo watch
polls every 60 s).

## What one run does

1. **Stand-ins**, in a temp dir, on the instance's `PATH` only:
   - `gh` → `scripts/factory-e2e/fake-gh.mjs`: a scripted GitHub held in
     `gh-state.json` (PRs, issues, checks, required checks, merges); every call
     is logged.
   - `claude` → `scripts/factory-e2e/claude.mjs` (the identifiable entry point for `fake-claude.mjs`) (stub scenarios only): a
     scripted fan-out worker that reports `review_requested` through the real
     `ledger_update` tool, and for a `default`-preset task commits and pushes (through `task_push`)
     its branch. Worker panes start with the run's own `ZDOTDIR` instead of the
     user's shell rc; its `.zshrc` puts the stand-ins first on the pane's PATH.
   - `codex` → `scripts/factory-e2e/fake-codex.mjs` (stub scenarios only):
     answers the version and rules check main runs before a bot's codex
     worker launches, then runs the same scripted worker, logged with
     `agent: "codex"` (and whether main's rules file was in place).
   - an ssh stand-in (`GIT_SSH_COMMAND`) that serves the scratch repo's remote
     `ssh://git@github.com/acme/app.git` from a local bare repo, so the repo key
     is `github.com/acme/app` and fetch/push work offline. Every other remote
     is refused, and `GH_CONFIG_DIR` is an empty dir (no GitHub token reaches
     the instance).
2. `control-wmux launch` of a wrapper that runs Electron on this checkout with
   an isolated `WMUX_DATA_SUFFIX`.
3. As the operator (the renderer's `electronAPI`, over CDP): the factory is
   switched on and the scenario's bots are created. A bot with a `script` runs
   on `BotEngine {kind:'acp'}` = `scripts/acp-stub.mjs` with that script; a bot
   without one (only in `model: real` scenarios) runs on the default engine.
4. The scenario's actions. Waits only observe the instance's files.
5. `control-wmux stop`, then the **evidence snapshot** is read from the data
   dir (facts, wake queue, handoffs, room cards, bots, ledger, verdicts, merge
   effects, repo-watch state) plus the stand-ins' logs and the factory lines
   of `app.log`. Bot token files are never read. Then the instance's data is
   removed.

## Grading

A grader is a pure function `(snapshot, expect) → criteria[]`. A run:

- **ERROR** when `evidence_complete` fails: no snapshot, a harness error (a
  launch, a setup call, a `required` wait or the stop failed), or a source the
  scenario `requires` is missing or does not parse (`ghCalls` and `workers`
  are the stand-ins' logs). This is the harness, not the factory:
  investigate the run, do not count it.
- **FAIL** when any criterion fails (a grader that throws fails closed).
- **PASS** when every criterion passes.

Graders have fixtures in `scripts/__tests__/fixtures/factory-graders/` (a
trimmed passing snapshot plus mutations that each break one behaviour) and run
in the normal vitest suite (`scripts/__tests__/factoryGraders.test.mjs`); no
app launch.

Layers: `regression` (`runs: 1`, every factory change) and `workflow`
(`runs: 3`, report the pass rate). `model: stub` scenarios are deterministic;
`model: real` ones need `--allow-real` and use the user's own engine login.

## Add a scenario

1. `scripts/factory-scenarios/<name>.json`:
   ```json
   {
     "name": "<name>", "layer": "regression", "runs": 1, "model": "stub",
     "description": "what behaviour, in one or two sentences",
     "setup": {
       "repo": true,
       "gh": { "issues": [], "prs": [] },
       "worker": { "commit": false, "delayMs": 1500 },
       "settings": { "laneAutoMerge": false },
       "env": { "WMUX_TEST_ROUTINE_MIN_MS": "60000" },
       "bots": [ { "key": "lead", "role": "lead", "repo": true, "budget": {}, "triggers": [],
                   "script": { "turns": [ { "steps": [ { "tool": "room_post", "args": {} } ] } ] } } ]
     },
     "actions": [ { "do": "post", "label": "msg", "post": { "title": "…", "to": "lead" } },
                  { "do": "waitFor", "cond": { "wakes": { "bot": "lead", "state": "done" } }, "timeoutMs": 60000 } ],
     "expect": { "requires": ["facts", "cards", "bots", "wakes"] }
   }
   ```
   A bot entry names its `role` (the legacy tag the default triggers and
   budget follow) and/or its `template` (`coordinator`, `developer`,
   `reviewer`, `issue`, `researcher`, `custom`), optionally a `job`, and
   `greet: true` for the first wake an added bot gets (wake reason `intro`;
   stub scripts must then script that turn). Every bot is created with
   `bot.create`; no Moa comes with the HQ setting.
   `repo: {"gate": false}` makes a scratch repo that declares no gate (no
   package.json). `worker.fileExt` names the extension of the file a
   committing worker adds (default `txt`). An `addPr` with
   `"filesFromBranch": true` lists the branch's own changed files as the
   PR's files.
   `env` sets `WMUX_TEST_*` knobs for the instance (main honours them only
   on an isolated instance). A `post` without `to` or `mentions` goes to every
   bot of the room, so every bot a group scenario declares needs a stub
   script for it. Stub scripts restart at their first turn
   after a `restart` (a new engine process).
   Actions: `emit` (operator `fact.emit`), `post` (an owner message), `wake`,
   `resolve` (answer a card), `gh` (`addIssue`, `addPr`, `setPr`, `moveHead`),
   `rpc`, `api`, `snapshotRead`, `readPages`, `markRead`, `waitFor`, `sleep`,
   `restart`, `loop`. Placeholders: `{{ws}}`, `{{bot.<key>}}`, `{{repoKey}}`,
   `{{repoPath}}`, `{{saved.<name>}}`. Stub steps: `tool`, `capture` (a regex
   on the wake prompt), `waitFor`, `sleep`, `say` (see `scripts/acp-stub.mjs`).
2. Keep the behaviour under test out of the stub script and the owner's
   message: the script calls only what the stub must call (no thread ids,
   no recipients the router decides), so what is graded is what main did.
3. A grader in `scripts/factory-graders/*.mjs`, registered in `index.mjs`.
4. A fixture `scripts/__tests__/fixtures/factory-graders/<name>.json`
   (`{ pass, fail: [{ why, failing, mutate }] }`) from a passing run's
   `evidence.json`, trimmed, with no local paths.
