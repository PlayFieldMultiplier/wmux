# BEHAVIOUR for wmux 3.38.1

Target: L-23 (W2 behaviour). Source: the locked checkout `openwong2kim\wmux\checkout\tag-v3.38.1`, commit 245ba5e80. Every row is a claim about what the source does. Each row says how it was checked:

- **SRC-CHECKED** (AO_WMUX, 2026-10-30): the cited file and line were read with sed or grep in the locked checkout.
- **DIGEST**: carried from `docs/org/research/RESEARCH-DIGEST.md`. Not re-read in this pass.
- **LIVE**: needs a running instance. Not done. It waits for the launch rule (F8 section 8).

## 1. Data isolation

| # | Claim | Where | How checked |
|---|---|---|---|
| B1 | A dev build (`!app.isPackaged`) with no suffix sets `WMUX_DATA_SUFFIX='-dev'`. | `src/main/index.ts` 263-264 | SRC-CHECKED |
| B2 | When `WMUX_DATA_SUFFIX` is set, the main process sets Electron userData to `originalUserData + suffix`, before the lock check. | `src/main/index.ts` 266-270 (`setPath` at 270) | SRC-CHECKED |
| B3 | `dataSuffix()` returns `process.env.WMUX_DATA_SUFFIX` or the empty string. | `src/shared/constants.ts` 501-502 | SRC-CHECKED |
| B4 | The main RPC pipe on Windows is `\\.\pipe\wmux<suffix>-<user>`. | `src/shared/constants.ts` 507, return at 512 | SRC-CHECKED |
| B5 | The MCP broker pipe on Windows is `\\.\pipe\wmux-mcpb<suffix>-<user>`. | `src/shared/constants.ts` 524, return at 527 | SRC-CHECKED |
| B6 | `getWmuxDir()` returns `~/.wmux<suffix>` (config.json lives there). | `src/daemon/config.ts` 14 | SRC-CHECKED (line 14 read; the return line is in 14-20) |
| B7 | The single-instance lock is per userData, so a suffixed instance gets its own lock. | `src/main/index.ts` ~314 | DIGEST |
| B8 | Setting the suffix only in the parent shell is not enough: the exe must have it in its own environment, or `setPath` does not run and the app boots onto production `session.json`. The source has a guard that exits on mismatch. | `plans/multiagent-identity-hardening-plan.md` 34, 191-193 (digest); guard at `src/main/dataIsolation.ts` | DIGEST, guard location not re-read |

## 2. Per-workspace config profiles

| # | Claim | Where | How checked |
|---|---|---|---|
| B9 | Profile keys starting with `WMUX_` are rejected. | `docs/workspace-profiles.md` (digest) | DIGEST |
| B10 | Secret-looking keys (`*_KEY`, `*_TOKEN`, `*_SECRET`) are dropped on save. | `docs/workspace-profiles.md` (digest) | DIGEST |
| B11 | A profile applies to new panes only, and is stored in plaintext in `session.json` under userData. | `docs/workspace-profiles.md` (digest) | DIGEST |

## 3. Company module (3.38.1)

| # | Claim | Where | How checked |
|---|---|---|---|
| B12 | `src/company/` contains 28 `.ts` or `.tsx` files. | `src/company/` | SRC-CHECKED (`find` limited to that path, count 28) |
| B13 | The company RPC handler is `src/main/pipe/handlers/company.rpc.ts`. | file path | DIGEST (size 11,428 bytes) |
| B14 | The company MCP tools `company_a2a_*` exist in 3.38.1 and were removed upstream by PR 1165 (2026-09-02). | MCP tool definitions | DIGEST |

## 4. Not in this file

- **LIVE**: whether an agent in a suffixed window reaches its own wmux (RESEARCH-DIGEST UNVERIFIED). Needs a running instance.
- **LIVE**: any isolation claim (B1-B8 at runtime). Needs a launched instance; the launch rule applies.
- **DIGEST rows not re-read**: B7, B8, B9-B11, B13, B14. They are kept with their source. A later pass should check each one against the locked checkout.
