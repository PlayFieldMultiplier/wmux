# Electron e2e

`npm run test:e2e` builds the app (`build:daemon`, `build:mcp`, then
`e2e/build.mjs`, which runs forge's own Vite config generator without
packaging) and runs `e2e/*.e2e.test.mjs` with node's test runner. On Linux
without a display it wraps the run in `xvfb-run`. It is not part of `npm test`
or vitest.

- **Isolated**: each run gets a fresh `HOME` under the temp dir and
  `WMUX_DATA_SUFFIX=-e2e`, so it never touches a real wmux, and it kills its
  own app, daemon and ptys afterwards (matched by `WMUX_E2E_RUN` / `HOME`).
- **No model**: `e2e/fake-bin/claude` stands in for Claude Code. As a fan-out
  worker it runs the scenario's shell script in its worktree.
- **Local remote**: the project is cloned from a bare repository in the sandbox.
- **Artifacts**: screenshots go to `e2e/artifacts/` (override with
  `WMUX_E2E_ARTIFACTS`). Set `WMUX_E2E_SKIP_BUILD=1` to reuse a build and
  `WMUX_E2E_KEEP=1` to keep the sandbox HOME.
- **macOS**: the sandbox lives under `/tmp` (the per-user temp dir is too long
  for the daemon's Unix sockets), Electron's userData is pointed into the
  sandbox with `--user-data-dir`, cleanup reads `ps -E` where there is no
  `/proc`, and the app runs with `--use-mock-keychain`: the sandbox HOME has no
  login keychain, so the first safeStorage call would block the app's main
  thread on a keychain dialog (forever on a locked screen).

## First run from a packaged build

`npm run e2e:first-run -- --app <packaged wmux executable>` (for example
`out/wmux-win32-x64/wmux.exe` after `npm run package`) checks the path a new
user takes: a fresh profile opens the welcome wizard, the "Agent ready" card
shows Claude Code ready, the wizard installs the hooks, "Try sample task"
starts the agent in a pane and the wizard closes, and the sidebar lists Claude
Code at a status at rest. It is a separate script, not a `node --test` file,
because it drives an already packaged app.

- **Isolated**: a unique `WMUX_DATA_SUFFIX` and a sandbox home under the temp
  dir (`HOME`; on Windows also `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`), so
  the hooks install lands in the sandbox. `WMUX_NO_PATH_REFRESH=1` keeps the
  Windows registry PATH from putting real agents ahead of the fakes.
- **MCP registration is seeded, not clicked**: agent configs are not
  per-suffix, so a suffixed instance never writes them, and the registrar uses
  Electron's own home (`app.getPath('home')`), which a sandboxed `HOME` does
  not move. The sandbox starts with a `~/.claude.json` holding the wmux entry;
  never set `WMUX_MCP_REGISTER_EXTERNAL=1` here. The run fails if app.log
  shows a registrar write outside the sandbox.
- **No model**: `scripts/fixtures/fake-agents/claude.mjs` and `codex.mjs` come
  first on PATH (`claude.cmd` + `claude.js` on Windows, a shell script
  elsewhere). They answer `--version` (9.9.9) and the sign-in status probes as
  signed in; the scenario fails if the ready card shows any other version.
- **Driver**: every UI step goes through `scripts/control-wmux.mjs` with
  `data-testid` handles, with its state and evidence in the run's folder
  (`CONTROL_WMUX_DIR`).
- **Teardown** runs on every exit: `control-wmux stop --purge`, then any
  process from the app's or daemon's tree still alive (same pid and creation
  time) is killed and fails the run, then the sandbox is deleted. Suffixed data
  left outside the sandbox also fails the run.
- **Artifacts**: `e2e/artifacts/first-run/<time><suffix>/` (override with
  `--artifacts` or `WMUX_E2E_ARTIFACTS`): `result.json` (steps, timings,
  teardown check), `fake-agents.jsonl`, and under `evidence/` app.log plus,
  on failure, a screenshot, an ARIA snapshot, doctor.json and the daemon logs.
  `--keep` keeps the sandbox home.
- Exit 0 on pass; otherwise 1 and one line,
  `first-run e2e: FAIL at <step>: <reason>`.

## Scenarios

- `fanout-cost.e2e.test.mjs` — the fan-out cost baseline (PRD E0 R0-2). An
  ordinary agent pane fans out three tasks and follows them to
  `review_requested`. `fanout-parent.mjs` plays that parent inside the pane
  through the real MCP bundle (`mcpClient.mjs`), and `fanout-worker.mjs`
  reports for each fake worker. It prints MCP calls, characters received
  (total and worker-written) and nudges, and saves them to
  `e2e/artifacts/fanout-cost.json`. The parent does only what the product
  tells it to, so the counts are lower bounds for a real agent. After one
  build, `node --test e2e/fanout-cost.e2e.test.mjs` runs it alone.
