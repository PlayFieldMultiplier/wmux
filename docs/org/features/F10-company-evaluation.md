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

Question 1 (how a company starts): NOT YET ANSWERED.

What was observed, labelled:
- VERIFIED (screenshot, 03:29): the -wmux-app sidebar has four entries: Agent, Git, Channels, web. The Agent button opens a right-hand panel titled "Agent (Default)" with a "FLEET" list (one PowerShell 7 entry, idle), "Loop" and "Schedules" controls, and a message box.
- VERIFIED (screenshot, 03:29): the "Agent (Default)" dropdown lists only model choices: Default, Opus 4.8, Sonnet 5, Haiku 4.5. It does NOT list a company.
- VERIFIED (screenshot): the bottom bar has Attach, Files, Snippets, Rich Input, Broadcast, Multi Task, New chat. None is labelled company.
- UNVERIFIED: whether "Channels" or "Multi Task" opens the company view. Not yet tried.

Next, in this order: open Channels, then Multi Task, each read by screenshot, with the same process-guarded click.

## Run 1, continued (2026-10-31, 03:4x)

- VERIFIED (process guard): a coordinate click on the sidebar Channels entry was NOT sent. The topmost window at that point is VS Code (pid 56304, `deck-schedules.json`), not -wmux-app (pid 56644). The guard stopped it.
- VERIFIED (UI Automation): the Channels element in -wmux-app exposes no InvokePattern ("Unsupported Pattern"). An invoke attempt failed. A script's trailing "invoked" line was printed in error and is not a click.
- Consequence: reaching Channels needs the -wmux-app window raised to the front, which moves focus. Not done, because it changes focus on Victor's machine.
- Next route, which needs no focus change: call the company RPC methods directly over the -wmux-app pipe (`wmux-wmux-app-victorb`), starting with company.status and company.create. This answers question 1 from the source's own method surface. The pipe client must be written first.

## Run 1, RPC route (2026-10-31)

- VERIFIED (live, read-only): the -wmux-app pipe `\.\pipe\wmux-wmux-app-victorb` accepts a request framed as one JSON line with id, method, params, token and clientName, and answers it. Framing taken from `src/cli/client.ts` in the locked checkout.
- VERIFIED (live): `company.status` was refused. Response: `plugin is unconfirmed (observed clientName: "wmux-cli")`. Rejection reason `identity-status`, capability `wmux.internal`, status `unconfirmed`.
- VERIFIED (source): `wmux.internal` is a reserved capability that no plugin declaration can grant (PermissionEnforcer.ts 422-425, per the 4.13 read; the 3.38.1 gate is the same family and needs confirming before a claim). The CLI tier is trusted only through a verified caller identity, which a raw pipe client does not have.
- UNVERIFIED: whether the first-party CLI process, run inside a wmux pane, gets that identity via its pane PID map (the CLI help says "verified PID-map identity"). Not tested.
- Consequence for question 1: company methods are reachable only from a verified first-party caller. Creating a company from outside the window needs that identity, so the answer to "how does a company start" is currently the UI or a first-party caller inside the window.
- Next: test the first-party route from inside a -wmux-app pane (a shell in that window's pane, running the CLI with the suffix). Do not raise or focus the window to do it.

## Run 1, first-party route tested (2026-10-31)

- VERIFIED (live): the same request, sent from a shell inside the -wmux-app pane (pane pid chain of the window's own shell), was refused with the same `identity-status` / `unconfirmed` rejection. The pane's process tree did not change the outcome. The server keys trust on the declared `clientName`, not on process ancestry.
- VERIFIED (live, from the refusal text): the way to get trust is `mcp.identify` followed by `mcp.declarePermissions`. A plugin cannot be granted `wmux.internal`, so that route cannot reach company.* either.
- Conclusion for question 1 (how a company starts, as built in 3.38.1): company.* is NOT callable by an outside agent over the pipe. The UI is the only verified path in this run, and the UI has not yet been reached (Channels needs the window raised; see the previous section).
- Hypothesis, UNVERIFIED: the intended agent route is the company MCP tools (company_a2a_whoami, send, broadcast, inbox, ack, status; B14 in BEHAVIOUR-3.38.1). These run from an MCP server bundle, not a raw pipe client. Test next by calling one from an MCP-connected agent inside the -wmux-app window.

## Run 1, MCP route (2026-10-31)

- VERIFIED (live, stdio, read-only): the 3.38.1 MCP bundle, started with the -wmux-app suffix, completes the MCP handshake (serverInfo `wmux` 3.38.1) and lists 86 tools, six of them company tools: company_a2a_whoami, company_a2a_send, company_a2a_broadcast, company_a2a_inbox, company_a2a_ack, company_a2a_status.
- VERIFIED (live): `company_a2a_whoami` called from outside any wmux terminal returns `isError: true`, text "Workspace identity unknown. This MCP server cannot determine which workspace it belongs to. Make sure you are running inside a wmux terminal workspace."
- Consequence: the company MCP tools need the MCP server to be started inside a wmux terminal workspace, so it can identify its workspace. That is the intended agent route.
- Next test, read-only: run the same probe from the -wmux-app pane's own shell, then call company_a2a_whoami. Expected: an identity or a clearer refusal. Recorded as the next step.

## Run 1, MCP route from inside the pane (2026-10-31)

- VERIFIED (live, read-only): the same probe, run from the -wmux-app pane's own shell, lists the same 86 tools, and `company_a2a_whoami` now answers `{"error": "no company active"}` (not `isError`). So the MCP server identified its workspace from the pane.
- VERIFIED (live, from the six company tool names): none of the six creates a company. Their names are whoami, send, broadcast, inbox, ack and status. A company must already exist before these tools do anything.
- Question 1, partly answered: a company is created by `company.create` (RPC, first-party only; refused to outside callers) or through the UI (not yet reached). Creating one from an agent's MCP session is not possible in 3.38.1.
- Next: reach the UI company entry without raising the window. Option, UNVERIFIED: Channels or Multi Task. Raising the window moves focus, so this is still blocked on a route that does not move focus.

## Run 1, UI attempt (2026-10-31, 05:26)

- VERIFIED (UI Automation, no click): "Multi Task" and "New chat" in -wmux-app expose InvokePattern; Agent, Git, Channels and web do not. New chat is not invoked: it may start a paid agent session.
- VERIFIED (screenshot, 05:26): the desktop is on the Windows LOCK SCREEN. The Multi Task invoke was sent, but nothing in the window is visible, so its effect is UNVERIFIED.
- Consequence: no UI route to the company entry works while the desktop is locked. Blocked until the desktop is unlocked by its user. Not unlocked by AO_WMUX.
- Next, when unlocked: screenshot, then Multi Task, read by screenshot.

## Run 1, desktop state (2026-10-31, 06:0x)

- VERIFIED (screenshot): the desktop is no longer on the lock screen. It shows the wallpaper.
- VERIFIED (UI Automation): the -wmux-app top-level window reports Normal and on-screen (rect 328,222,1600,1000).
- VERIFIED (screenshot of that rectangle): the window area shows only the wallpaper. The window is not painting on the desktop. Cause UNVERIFIED (likely the lock/unlock cycle).
- VERIFIED (CLI, read-only): the -wmux-app shell pane still answers through the CLI (`read-screen` shows its prompt; the pane is alive).
- Decision: AO_WMUX did not restart or kill the instance. Restarting a running instance is a shared-state action and is not taken without a reason.
- Next: keep using the CLI route (read-only) to watch the instance, and re-check the window paint on the next tick.
