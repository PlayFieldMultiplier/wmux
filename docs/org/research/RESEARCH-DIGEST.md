# Research digest: everything verified so far

Every item lists its source. Items marked **VERIFIED** were read directly from the cited file or API response. Items marked **UNVERIFIED** are inferences that still need a live test.

## 1. Version and lock

- **VERIFIED.** The fleet was pinned to wmux 3.38.1 on 2026-10-29. The lock text is in `C:\.______\.KADMON\.WMUX__\AGENTS.md`, under "Fleet version lock", and in the loaded agent file `PFM___\.claude\agents\ao-wmux.md` (merged as PR #144).
- **VERIFIED.** Installed build path: `C:\Users\victorb\AppData\Local\wmux\app-3.38.1`.
- **VERIFIED.** Locked source: `C:\.______\.KADMON\.WMUX__\src\openwong2kim\wmux\checkout\tag-v3.38.1`, a git checkout of tag `v3.38.1`.
- **OPEN.** The lock still names 3.38.1 as the installed and fleet version. Forking to this org changes which version we modify, so the lock text must be updated by PR, after Victor approves the wording (see LEDGER L-07).

## 2. Instance isolation: a second wmux with its own data

- **VERIFIED.** `WMUX_DATA_SUFFIX` is read at `src/main/index.ts` (about lines 255–330). When set, it appends to Electron `userData` via `app.setPath('userData', originalUserData + suffix)`.
- **VERIFIED.** The same suffix is applied in `src/shared/constants.ts` (lines 495–535): `dataSuffix()`, `getPipeName()` (`wmux<suffix>-<user>` on Windows), and `getMcpBrokerPipeName()` (`wmux-mcpb<suffix>-<user>`).
- **VERIFIED.** `src/daemon/config.ts` (lines 10–20): `getWmuxDir()` returns `~/.wmux<suffix>`, which holds `config.json` and the daemon token. The daemon pipe is not a file in that directory: on Windows it is a named pipe whose name carries the suffix (`src/shared/constants.ts` lines 657–663). Corrected 2026-10-30 after review of PR 3.
- **VERIFIED.** `src/shared/constants.ts` (about lines 700–735): the daemon auth token path is suffix-aware, with a read-only fallback to the unsuffixed legacy path.
- **VERIFIED.** The single-instance lock is `app.requestSingleInstanceLock()` (`src/main/index.ts`, about line 314). Because userData differs, a suffixed instance gets its own lock.
- **VERIFIED. TRAP.** `plans/multiagent-identity-hardening-plan.md` (line 34 and lines 191–193) documents this failure: if the suffix is not present in the launched process's own environment, `setPath` never runs. The app then boots onto production `session.json` and restores the wrong workspaces. The source has a guard (`checkUserDataIsolation` in `src/main/dataIsolation.ts`) that exits when the mismatch is detected. **Design consequence:** the launcher must set the variable on the exe process itself, and the first launch must check the `[Main] WMUX_DATA_SUFFIX=... → userData=...` log line.
- **VERIFIED.** Prior live testing of isolated packaged instances exists: `plans/a2a-pane-identity-mcp-registration-IMPL.md` (line 195), `plans/issue-285-pane-lifecycle-mcp-tools.md` (line 288), `plans/lanlink-pr3-design.md` (line 169).
- **UNVERIFIED.** That an agent in a suffixed window reaches its own wmux. The source suggests the MCP shim picks its pipe from the environment (`getPipeName` reads `dataSuffix()`), so PTYs spawned by a suffixed daemon should inherit it. This needs a live test.
- **VERIFIED.** The dev build sets `WMUX_DATA_SUFFIX=-dev` automatically when `!app.isPackaged` (`src/main/index.ts` about line 263). Packaged builds default to no suffix.

## 3. Per-workspace configuration (no second window needed)

- **VERIFIED.** `docs/workspace-profiles.md` describes per-workspace environment profiles. A profile sets environment variables and an optional startup command for **new panes only**. It is the mechanism behind per-account config directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **VERIFIED.** Profile keys starting with `WMUX_` are rejected. Secret-looking keys (`*_KEY`, `*_TOKEN`, `*_SECRET`) are dropped on save. A profile should point at a config directory, not hold a credential.
- **VERIFIED.** The profile is stored in plaintext in `session.json` under userData, and it is not re-applied on restart.

## 4. The company module in 3.38.1

- **VERIFIED.** `src/company/` holds 28 files, 238,028 bytes. It includes `core/` (AgentPersonaGenerator, MessageQueue, workflows, presets, SoulLoader, CostEstimator and others), `main/` (CircuitBreaker, company.rpc, CompanyTemplateManager, WorktreeManager), `mcp/index.ts`, and `renderer/` (CompanyView, ApprovalDialog, MessageFeedPanel, CreateCompanyDialog, store, provisioner, rpcHandlers).
- **VERIFIED.** `src/main/company/` holds 3 files, about 15 KB. `src/main/pipe/handlers/company.rpc.ts` is 11,428 bytes.
- **VERIFIED.** The MCP tools `company_a2a_whoami`, `_send`, `_broadcast`, `_inbox`, `_ack` and `_status` exist in 3.38.1. They were removed upstream in PR #1165 (2026-09-02). This fork keeps them.
- **VERIFIED.** `docs/api/inventory.md` (line 146) labels company mode "experimental" and says it is being re-evaluated as a reference orchestrator on top of the substrate.
- **VERIFIED.** `ARCHITECTURE.md` (line 132) describes company mode as "Multi-agent org: CEO -> departments -> members".
- **Gap.** The 3.38.1 company model has a CEO, departments and members. It does not have a per-workspace coordinator, a company-level unified work stream, or department-scoped routing as a durable store. See F2, F3 and F5.

## 5. Upstream 4.x: what changed, as far as read so far

- **VERIFIED.** The latest upstream tag is `v4.13.0`. The company code moved to `src/company/` with 13 files and 103,515 bytes. `src/company/renderer/provisioner.ts` is 16,450 bytes. `src/company/core/` has SoulLoader, builtinTemplates, messageTemplates and soulMapping. (Read from the git trees API, not cloned.)
- **VERIFIED.** The 4.13 company RPC handler is `src/main/pipe/handlers/company.rpc.ts`, at 12,868 bytes.
- **UNVERIFIED.** The permission gates on agents creating or naming their own panes and surfaces, and the config step before launching panes. The code search returned nothing, and the blobs have not been read. Victor's report is the only source so far. F4 must read the actual code before deciding what to strip.
- **Upstream direction** is covered in `research/UPSTREAM-COMPANY-SURVEY.md`.

## 6. Local fleet facts that constrain the design

- **VERIFIED.** The MERIDIAN fleet's relaunch mechanism is `~/.agents/*.ps1` scripts, each a wrapper over `resume-agent.ps1`. `resume-agent.ps1` reads name, agent and model from the session JSONL, honours `-Model` and `-DryRun`, and always appends `--dangerously-skip-permissions` (`C:\Users\victorb\.claude\wmux-control.md`).
- **VERIFIED.** Never run two relaunches of the same identity concurrently. A double-launch incident is recorded in `~/.agents/ao-wmux/AGENTS.md`. That file is not loaded by any agent, so the rule is also in F7.
- **VERIFIED.** The Remote Control blast radius is account-wide. Any write to `~/.claude/.credentials.json` disconnects every Claude Code process on the machine at once, and a wmux restart does the same for every daemon tied to the identity. A second wmux instance does not isolate credentials. The credentials are in the global `~/.claude`. Only a separate `CLAUDE_CONFIG_DIR` per instance would isolate them, and that is untested for this fork.
- **VERIFIED.** Standing rules that apply to every agent in this set: type text, send Enter as a separate key, then read back (`C:\Users\victorb\.claude\wmux-control.md`). Before any raw send, read the target pane and confirm the input is empty. Roster checks use `surface_list`, not `pane_list` alone.
- **VERIFIED.** The live fleet has eight agent surfaces in one workspace, `ws-4fc1b556-…`, named "Office-Of/MERIDIAN-0QQ/__". Workspace list shows 22 workspaces in total, many of them empty `MCP` placeholders.

## 7. Target locations on this machine

- **VERIFIED.** `C:\.______\.KADMON\PLAY__\FIELD_\MULTI_\PLIER_\_\AS\MERIDIAN\BLUE\OTTOBOT\_` exists and is empty.
- **VERIFIED.** `…\AS\WMUX\APP\_` does not exist.
- **VERIFIED.** `…\AS\LeagueOS` is a checkout of `PlayFieldMultiplier/LeagueOS`. It is on branch `bernoulli/release-1.0.5.12-chunk4` with unrelated untracked work, so do not commit there. See F7.
- **OPEN.** The parent of the `AS/WMUX/APP/_` subspace is not confirmed. The request names `AS/MERIDIAN/BLUE/OTTOBOT/_` as the place, and that folder exists. Whether `WMUX/APP` sits under it or beside it is a decision for Victor (LEDGER L-09).

## 8. Governance and access

- **VERIFIED.** The acting `gh` account is `DarienSirius`. The office procedure prefers `ottopoet-thesean` for OPT work, with `DarienSirius` as a fallback only when a permission is demonstrably missing. The fork was created as `DarienSirius`, and that attribution is recorded in LEDGER L-01.
- **VERIFIED.** Shared PFM work goes through a worktree, a branch, a PR, and `bash deploy/scripts/pfm-merge.sh <N> --repo Office-Of/KPFM-1`.
