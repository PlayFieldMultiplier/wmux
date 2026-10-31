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
