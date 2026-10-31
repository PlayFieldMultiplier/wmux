# F10: Evaluate the company feature by running real agents through it

Status: sprint 2, in progress. Owner: AO_WMUX. No human-in-the-loop approvals (Victor, 2026-10-31); decisions are recorded here with reasons.

## Goal
Decide, from observed runs, what the company feature does, where it breaks, and what the org should keep, change or drop.

## Definition of done
- At least one real company run is executed in the `-wmux-app` window, with agents as participants, and its evidence (screen reads, logs, PTY output) is recorded.
- Each claim about the feature cites the file and line in the locked checkout, or the run evidence, and is labelled VERIFIED or UNVERIFIED.
- A written verdict per capability: keep, change (with the change), or drop (with the reason).

## Verified so far (3.38.1, locked checkout)
- Module: `src/company/` with `core/` (AgentPersonaGenerator, CostEstimator, MessageQueue, SoulLoader, messageTemplates, presets, soulMapping, workflows, builtinTemplates), `main/`, `mcp/`, `renderer/`, `types.ts`. Source: directory listing, 2026-10-31.
- The wmux CLI has NO company subcommands (`wmux.cmd --help`, 2026-10-31). The feature is reached through the UI or the company MCP tools.
- Company RPC handler: `src/main/pipe/handlers/company.rpc.ts` (digest, 2026-10-30; not re-read).

## Open questions (to answer by running it)
1. How does a company start: which UI control or MCP call creates one?
2. How are agents added, and do they run as real Claude sessions or as simulated personas?
3. What does MessageQueue do between agents, and is it reached from a real agent's pane?
4. Workflows and presets: do they execute, or only describe?
5. CostEstimator: does it report a real figure, and from what input?

## Method
- Run in the `-wmux-app` window (its suffix, WMUX_DATA_SUFFIX=-wmux-app, on the CLI call only).
- Read the screen before every action; confirm dialogs by screenshot, never blind.
- Record each run's start, actions and result in this file, dated.
