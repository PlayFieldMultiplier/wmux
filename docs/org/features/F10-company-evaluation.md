# F10: Evaluate the company feature by running real agents through it

Status: sprint 2, in progress. Owner: AO_WMUX. No human-in-the-loop approvals (Victor, 2026-10-31); decisions are recorded here with reasons.

## Goal
Decide, from observed runs, what the company feature does, where it breaks, and what the org should keep, change or drop.

## Definition of done
- At least one real company run is executed in the `-wmux-app` window, with agents as participants, and its evidence (screen reads, logs, PTY output) is recorded.
- Each claim about the feature cites the file and line in the locked checkout, or the run evidence, and is labelled VERIFIED or UNVERIFIED.
- A written verdict per capability: keep, change (with the change), or drop (with the reason).

## Facts (each labelled; source and date given)
- VERIFIED (source, 2026-10-31): `src/company/` contains `core/`, `main/`, `mcp/`, `renderer/` and `types.ts`. Source: directory listing of tag v3.38.1.
- VERIFIED (source, 2026-10-31): `src/company/core/` contains AgentPersonaGenerator, CostEstimator, MessageQueue, SoulLoader, messageTemplates, presets, soulMapping, workflows and builtinTemplates. Source: directory listing.
- VERIFIED (source, 2026-10-31): the CLI source `src/cli` has no reference to "company" (case-insensitive grep, 0 files). The wmux CLI cannot drive a company. Source: grep of tag v3.38.1.
- VERIFIED (source, 2026-10-31): `src/main/pipe/handlers/company.rpc.ts` (304 lines) registers 22 RPC methods (grep of `router.register('company`): company.create, company.destroy, company.status, company.addDept, company.removeDept, company.addMember, company.removeMember, company.broadcast, company.sendDept, company.sendMember, company.save, company.restore, company.templates, company.worktreeSetup, company.mergeDept, company.a2a.whoami, company.a2a.send, company.a2a.broadcast, company.a2a.inbox, company.a2a.ack, company.a2a.status, company.message. Bodies not read.
- UNVERIFIED: the behaviour of each company RPC method. Only the registrations were read, not their bodies.
- UNVERIFIED: the `-wmux-app` suffix value. It is set by the launcher's environment, not a literal in the source; the window's data directory `wmux-wmux-app` was observed on disk on 2026-10-30.
- VERIFIED (source, reviewed 2026-10-31): the RPC allowlists. `company.create` and `company.status` are in neither the first-party MCP allowlist nor the CLI allowlist. `src/main/mcp/firstParty.ts:156` says `company.create` is intentionally absent from `FIRST_PARTY_METHODS`, and the list around lines 270-277 holds only `company.a2a.*`. `src/main/mcp/internalCli.ts:20` excludes company mutations. Both are mapped to the reserved capability `wmux.internal` in `src/main/mcp/methodCapabilityMap.ts:443-445`.

## Open questions (to answer by running it)
1. How does a company start: `company.create` is registered in company.rpc.ts; which UI control or MCP call reaches it is UNVERIFIED.
2. How are agents added, and do they run as real Claude sessions or as simulated personas?
3. What does MessageQueue do between agents, and is it reached from a real agent's pane?
4. Workflows and presets: do they execute, or only describe?
5. CostEstimator: does it report a real figure, and from what input?

## Method
- Run in the `-wmux-app` window (its suffix, WMUX_DATA_SUFFIX=-wmux-app, on the CLI call only).
- Read the screen before every action; confirm dialogs by screenshot, never blind.
- Record each run's start, actions and result in this file, dated.

## Run 1 (2026-10-31, in the -wmux-app window)

Question 1 (how a company starts): NOT YET ANSWERED. The sections below narrow the routes that are closed; the UI route is still open.

What was observed, labelled:
- VERIFIED (screenshot, 03:29): the -wmux-app sidebar has four entries: Agent, Git, Channels, web. The Agent button opens a right-hand panel titled "Agent (Default)" with a "FLEET" list (one PowerShell 7 entry, idle), "Loop" and "Schedules" controls, and a message box.
- VERIFIED (screenshot, 03:29): the "Agent (Default)" dropdown lists only model choices: Default, Opus 4.8, Sonnet 5, Haiku 4.5. It does NOT list a company.
- VERIFIED (screenshot): the bottom bar has Attach, Files, Snippets, Rich Input, Broadcast, Multi Task, New chat. None is labelled company.
- UNVERIFIED: whether "Channels" or "Multi Task" opens the company view. Not yet tried.

## Run 1, continued (2026-10-31, 03:4x)

- VERIFIED (process guard): a coordinate click on the sidebar Channels entry was NOT sent. The topmost window at that point is VS Code (pid 56304, `deck-schedules.json`), not -wmux-app (pid 56644). The guard stopped it.
- VERIFIED (UI Automation): the Channels element in -wmux-app exposes no InvokePattern ("Unsupported Pattern"). An invoke attempt failed. A script's trailing "invoked" line was printed in error and is not a click.
- Inference (UNVERIFIED): reaching Channels needs the -wmux-app window raised to the front, which moves focus. Not done at that time.

## Run 1, RPC route (2026-10-31)

- VERIFIED (live, read-only): the -wmux-app pipe `\.\pipe\wmux-wmux-app-victorb` accepts a request framed as one JSON line with id, method, params, token and clientName, and answers it. Framing taken from `src/cli/client.ts` lines 60 and 76 in the locked checkout.
- VERIFIED (live): `company.status` was refused. Response: `plugin is unconfirmed (observed clientName: "wmux-cli")`. Rejection reason `identity-status`, capability `wmux.internal`, status `unconfirmed`. The refusal text is produced at `src/main/pipe/RpcRouter.ts:426-433` and the identity-status rejection is typed in `src/shared/rpc.ts:192`.
- VERIFIED (source): `wmux.internal` is a reserved capability that no plugin declaration can grant. The statement is at `src/main/mcp/PermissionEnforcer.ts:297-299` in the 3.38.1 checkout. The earlier citation (422-425) was a 4.13 line number and is withdrawn.
- VERIFIED (source): the CLI tier is granted by the declared clientName `wmux-cli` together with a curated method set, not by a verified caller identity. Citations: `src/main/mcp/PermissionEnforcer.ts:230-245` and `src/main/mcp/internalCli.ts:30-40`.
- UNVERIFIED: whether the first-party CLI process, run inside a wmux pane, gets any identity via its pane PID map (the CLI help says "verified PID-map identity", `src/cli/index.ts:52`). Not tested.
- Consequence for question 1 (this is a conclusion from source, not a run): `company.create` and `company.status` are in neither allowlist, so the source gives no outside-agent route to them. Whether the UI is the only route is UNVERIFIED until the UI is reached.
- Next: reach the UI company entry in the -wmux-app window (Channels or Multi Task) and read it by screenshot.

## Run 1, first-party route tested (2026-10-31)

- VERIFIED (live): the same request, sent from a shell inside the -wmux-app pane (its own shell process chain), was refused with the same `identity-status` / `unconfirmed` rejection. The result shows only that `company.status` is refused from this shell with clientName `wmux-cli`. It does not prove the cause is identity. The cause is UNVERIFIED; the source places `company.status` outside the CLI allowlist (see the source section above).
- VERIFIED (live, from the refusal text): the refusal names `mcp.identify` followed by `mcp.declarePermissions` as the trust route. A plugin cannot be granted `wmux.internal`, so that route cannot reach company.* either (`src/main/mcp/PermissionEnforcer.ts:297-299`).
- VERIFIED (source, reviewed 2026-11-01): `company.create`, `company.destroy`, `company.status` and the other company mutations are on no allowlist. They are mapped to `wmux.internal` (`src/main/mcp/methodCapabilityMap.ts:443-445`), which a plugin cannot be granted, so an outside agent should not be able to call them.
- VERIFIED (source, reviewed 2026-11-01): `company.a2a.*` (whoami, send, broadcast, inbox, ack, status) are in `FIRST_PARTY_METHODS` (`src/main/mcp/firstParty.ts:270-276`). They are allowed for any caller whose declared clientName is in `FIRST_PARTY_CLIENT_NAMES` (`src/main/mcp/firstParty.ts:65`; allow rule at `src/main/mcp/PermissionEnforcer.ts:221-227`). The source does not verify the clientName, so a pipe client that declares a first-party name could reach these. UNVERIFIED live: this run did not test that, and it is not a claim that it works.
- The UI is the route this run has not yet verified.
- Hypothesis, UNVERIFIED: the intended agent route is the company MCP tools (company_a2a_whoami, send, broadcast, inbox, ack, status). These run from an MCP server bundle, not a raw pipe client. Test next by calling one from an MCP-connected agent inside the -wmux-app window.

## Run 1, MCP route (2026-10-31)

- VERIFIED (live, stdio, read-only): the 3.38.1 MCP bundle, started with the -wmux-app suffix, completes the MCP handshake (serverInfo `wmux` 3.38.1) and lists 86 tools, six of them company tools: company_a2a_whoami, company_a2a_send, company_a2a_broadcast, company_a2a_inbox, company_a2a_ack, company_a2a_status.
- VERIFIED (live): `company_a2a_whoami` called from outside any wmux terminal returns `isError: true`, text "Workspace identity unknown. This MCP server cannot determine which workspace it belongs to. Make sure you are running inside a wmux terminal workspace." The quoted text is at `src/mcp/index.ts:732` in the bundle's own server source. A shorter message exists in the standalone `src/company/mcp/index.ts:167`.
- UNVERIFIED (inference from the text above): the company MCP tools need the MCP server to be started inside a wmux terminal workspace so it can identify its workspace. This is the likely intended agent route.
- Next test, read-only: run the same probe from the -wmux-app pane's own shell, then call company_a2a_whoami.

## Run 1, MCP route from inside the pane (2026-10-31)

- VERIFIED (live, read-only): the same probe, run from the -wmux-app pane's own shell, lists the same 86 tools, and `company_a2a_whoami` answers `{"error": "no company active"}` (not `isError`). The source of that text is `src/company/renderer/rpcHandlers.ts:293`. The live response itself is what this run observed.
- VERIFIED (source, reviewed 2026-11-01): the six company MCP tools call `company.a2a.whoami`, `send`, `broadcast`, `inbox`, `ack` and `status` (`src/company/mcp/index.ts:181, :199, :219, :238, :254, :268`). They also call `a2a.resolve.identity` (`:100`) and `workspace.list` (`:89`) to resolve the workspace. None of them calls a method that creates a company. A company must already exist before these tools do anything.
- Question 1, route status: a company is created by `company.create` (RPC; source-derived: it is on no allowlist, so an outside caller should be refused. UNVERIFIED live for `company.create`, which was not sent) or through the UI (not yet reached). The MCP tools do not create one.
- Next: reach the UI company entry in the -wmux-app window. Option, UNVERIFIED: Channels or Multi Task. Raising the window moves focus.

## Run 1, UI attempt (2026-10-31, 05:26)

- VERIFIED (UI Automation, no click): "Multi Task" and "New chat" in -wmux-app expose InvokePattern; Agent, Git, Channels and web do not. New chat is not invoked: it may start a paid agent session.
- VERIFIED (screenshot, 05:26): the desktop is on the Windows LOCK SCREEN. The Multi Task invoke was sent, but nothing in the window is visible, so its effect is UNVERIFIED.
- Inference (UNVERIFIED): no UI route to the company entry works while the desktop is locked.
- Next, when unlocked: screenshot, then Multi Task, read by screenshot.

## Run 1, desktop state (2026-10-31, 06:0x)

- VERIFIED (screenshot): the desktop is no longer on the lock screen. It shows the wallpaper.
- VERIFIED (UI Automation): the -wmux-app top-level window reports Normal and on-screen (rect 328,222,1600,1000).
- VERIFIED (screenshot of that rectangle): the window area showed only the wallpaper. The window was not painting on the desktop. Cause UNVERIFIED (likely the lock/unlock cycle).
- VERIFIED (CLI, read-only): the -wmux-app shell pane still answers through the CLI (`read-screen` shows its prompt; the pane is alive).
- Decision: AO_WMUX did not restart or kill the instance. Restarting a running instance is a shared-state action and is not taken without a reason.

## Run 1, window restored (2026-11-01)

- VERIFIED (screenshot): the -wmux-app window is in front and paints. Its rectangle shows Workspace 1, a PowerShell 7 pane with the earlier company-probe output, and the Agent panel. The window was brought to the front through a thread-attach focus request (AttachThreadInput plus SetForegroundWindow), after a plain SetForegroundWindow was refused. No restart.
- VERIFIED (screenshot): Multi Task opens a dialog titled "Multi Task — N parallel isolated tasks". Its own text says each task gets a worktree and an idle agent pane. Its working directory is the shared PFM root, so it was NOT submitted. It was closed by a second invoke of the Multi Task button; Escape did not close it.
- Decision (not a fact): the Multi Task route is not used in this workspace until its target folder is a fork worktree. The company entry is still not reached. Question 1 stays NOT YET ANSWERED.
