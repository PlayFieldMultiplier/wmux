# F1: Instance isolation (a second wmux window with its own data)

**Goal:** the org can run a wmux window beside the production window, with its own sessions, config, daemon, pipes and credentials-pointer, and no shared state with production.

**Steps:**

1. Launch the org instance with `WMUX_DATA_SUFFIX=-pfm` set on the exe process itself, through `C:\Users\victorb\.agents\pfm.ps1`.
2. On first launch, confirm the log line `[Main] WMUX_DATA_SUFFIX="-pfm" → userData="…-pfm"`, and confirm the production `session.json` was not read.
3. Confirm `C:\Users\victorb\.wmux-pfm\` was created, and that the daemon pipe name carries the suffix.
4. Run the isolation check (below) before adding any workspace.

## Current state (verified in source, 3.38.1)

- The suffix mechanism is in `src/main/index.ts`, `src/shared/constants.ts`, `src/daemon/config.ts`. See `research/RESEARCH-DIGEST.md` section 2.
- Isolated packaged instances have been run in live dogfood before, per the plans cited in the digest.
- A guard, `checkUserDataIsolation` in `src/main/dataIsolation.ts`, exits the app if the suffix did not reach `userData`.

## Gap

- No launcher for the org instance exists.
- No check exists that the production `session.json` was not read.
- Credentials are not isolated. `~/.claude` is global. A login in one window disconnects Remote Control in every window on the machine.
- Whether an agent in the org instance reaches its own daemon is unverified (RESEARCH-DIGEST section 2).

## Design

- **Launcher** `pfm.ps1` sets `WMUX_DATA_SUFFIX` in the process environment before starting the exe. It does not rely on the parent shell's environment. It refuses to start if the suffix is empty.
- **Isolation check** `src/org/instance/isolation.ts` (new): given the suffix and the resolved paths, it asserts that `userData` ends with the suffix, the config dir is `~/.wmux<suffix>`, and the production `session.json` path is not the one loaded. It exits with an error otherwise. This mirrors the upstream guard and adds the path-level check upstream does not make.
- **Credentials policy.** Until F6 defines a per-instance config directory, the org instance uses the global `~/.claude`, and this is recorded as a known risk. Any login run in the org instance must be coordinated with F6, because it disconnects every window.

## Folder changes (fork)

- `src/org/instance/` (new): `suffix.ts`, `isolation.ts`, `launchEnv.ts`, with unit tests beside them.
- `config/org/launch/pfm.ps1.template` (new): the launcher template, with no secrets.

## Open decisions

- Whether the org instance gets its own `CLAUDE_CONFIG_DIR` (depends on F6, and on how Claude Code behaves with a separate config dir, which is untested).

## Verification

- Start the org instance. Read the log line. Read `%APPDATA%` and `~/.wmux-pfm` to confirm the paths.
- With the production window running, confirm the production `session.json` is unchanged after the org instance starts (compare hash before and after).
- Create one workspace in the org instance, quit, relaunch, and confirm the workspace comes back in the org instance only.

## Status

Designed. Not built. No launch has been run. Launching requires Victor's approval (LEDGER L-05).
