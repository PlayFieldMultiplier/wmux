# 4.x gates: pane creation, surface creation, launch configuration

Target: L-06. Victor's report (2026-10-29) is that 4.x gates pane and surface creation and adds a launch-configuration step. This file records what the code shows at the tag `v4.13.0`. It is a fact sheet, not a judgement on whether the gates should stay.

Source: `openwong2kim/wmux` at `v4.13.0`, read through the GitHub contents API. Citations below were checked by AO_WMUX on 2026-10-30 unless marked otherwise.

## 1. Pane creation

- The pane-creating RPC method is `pane.split`, registered at `src/main/pipe/handlers/pane.rpc.ts` (registration at line 430 per the raw read; not re-checked).
- **Confinement, not a permission gate.** `src/main/pipe/handlers/pane.rpc.ts` 452-458 (checked): when `ctx.commanderWorkspace` is set, an explicit `workspaceId` that differs from the commander's workspace is rejected with `pane.split: workspace is outside the commander's workspace`. An omitted workspace is pinned to the commander's own.

## 2. Surface creation

- The surface-creating RPC method is `surface.new`, registered at `src/main/pipe/handlers/surface.rpc.ts:80` (raw read).
- **Same confinement.** `src/main/pipe/handlers/surface.rpc.ts` 87-93 (raw read): the same commander check as pane.split.
- **Forwarded to the renderer.** `src/main/pipe/handlers/surface.rpc.ts:95` (raw read): `sendToRenderer(getWindow, 'surface.new', ...)`. No further check on this path.
- `surface.close` (not creation) has an `agentControl.refusal` hold at `surface.rpc.ts` 121-122 (raw read).

## 3. The enforcement layer that applies to every RPC method

This is the layer that can reject `pane.split` and `surface.new` on identity or capability grounds.

- `src/main/pipe/RpcRouter.ts:167` (checked): the field defaults to `private enforcementMode: EnforcementMode = 'shadow';`.
- `src/main/index.ts` 1221-1232 (checked): a comment says "Production wmux defaults to `enforce`; dev (electron-forge / npm start) defaults to `shadow`", and `resolveEnforcementMode({ isDev })` sets it. The override is `mcp.mode` in `~/.wmux/config.json`.
- `src/main/mcp/enforcementMode.ts:8` (checked): `Production wmux: enforce (the v3.0 ship target)`. Line 24: default `shadow` when dogfood, `enforce` otherwise.
- `src/main/pipe/RpcRouter.ts` 722-724 (checked): a non-`allow` outcome blocks the call only when the mode is `enforce`, or when `isAlwaysEnforcedMethod(request.method)` is true.
- `src/main/pipe/RpcRouter.ts` 727-732 (raw read): for an unconfirmed identity with declared capabilities, the router queues an approval prompt and returns `pendingApproval: { promptId }`. It does not wait for the answer.

**Net effect, as the code reads:** in a packaged production build the default is `enforce`, so a non-allow outcome from the mcp identity check blocks the RPC call. A dev build defaults to `shadow`. Neither `pane.split` nor `surface.new` is always-enforced (section 3a), so in `shadow` mode a non-allow verdict on either is not blocked. In `enforce` mode, which is the production default, it is.

### 3a. Always-enforced list (verified 2026-10-30 at v4.13.0)

- `src/main/mcp/methodCapabilityMap.ts:119` (checked): `ALWAYS_ENFORCED_RISK_CLASSES = new Set(['computer', 'agent-state', 'agent-state-all'])`.
- `methodCapabilityMap.ts` 122-125 (checked): `isAlwaysEnforcedMethod(method)` is true only when the method's `riskClass` is in that set.
- `pane.split` is `{ capability: 'pane.create', riskClass: 'pane-lifecycle' }` at line 217 (checked). `pane-lifecycle` is not in the set, so it is not always-enforced.
- `surface.new` is `{ capability: 'wmux.internal' }` at line 200 (checked). It has no `riskClass`, so it is not always-enforced.

## 4. Launch configuration step

Two daemon modules touch launch. Neither was traced end to end in this pass.

- `src/daemon/agentLoginGate.ts:13` (raw read): "Is this agent signed in for this account?" before a launch. A sign-in check, not a permission gate.
- `src/daemon/launchPresence.ts:2-3` (raw read): "did the agent this pane was asked to launch actually start?" A post-launch check, not a gate before launch.
- `src/daemon/automation/launch.ts:52` (raw read): `--permission-mode default` pinned for automation runs only.
- `src/daemon/approvals/gateConfig.ts:43-45` (raw read): the PreToolUse permission gate (`#783`) gates tool calls inside a running agent. It does not gate pane or surface creation.

## 5. Comparison with v3.38.1

Hit counts for the keyword set `permission|allow|gate|approve|confirm|requireApproval|pane.create|surface.new|createPane|createSurface|launch|config` (raw read, counts only):

| File | v3.38.1 | v4.13.0 |
|---|---|---|
| `src/main/pipe/RpcRouter.ts` | 30 | 53 |
| `src/main/pipe/handlers/pane.rpc.ts` | 6 | 7 |
| `src/main/pipe/handlers/surface.rpc.ts` | 5 | 5 |
| `src/main/mcp/PermissionEnforcer.ts` | 62 | 71 |
| `src/daemon/agentLoginGate.ts` | absent | 13 |

These are counts, not diffs. The code was not diffed between tags.

## 6. UNVERIFIED

- ~~Whether `pane.split` and `surface.new` are in the always-enforced list.~~ Resolved in section 3a: neither is.
- Whether a shipped install actually runs in `enforce`: the default written by `createDefaultConfig` in `src/daemon/config.ts`, and whether a user config at `mcp.mode` (section 3) overrides it, were not read.
- The launch step end to end: which code types the agent launch into a pane after `surface.new` or `pane.split`, and in what order `agentLoginGate`, `launchPresence` and the launch path run. Not traced.
- What `agentControl` holds can be set on. `src/main/browser-session/BrowserAgentControl.ts` was not read.
- Whether a `pendingApproval` result from `pane.split` or `surface.new` in `enforce` mode is reachable at all, which depends on the caller's trust record. Not traced.
- Whole-tree search for another pane- or surface-creation method name. Only `pane.rpc.ts` and `surface.rpc.ts` were checked.

## 7. What this does not say

It does not say the gates are good or bad. It does not say Victor's report is wrong. The open items are in section 6. The first to close is `createDefaultConfig` and the launch path, because they decide whether `enforce` actually reaches pane creation in a shipped install (L-27).

## 8. L-27 findings (v4.13.0, AO_WMUX spot-checked 2026-10-30)

Spot-checked: `daemon/config.ts` has no `mcp` string; `enforcementMode.ts:33`; `index.ts:1231-1232`; `pty.handler.ts:853` and `:862`; `scheduleInitialCommand.ts:89-93`.

### 8.1 Shipped default (section 6, first bullet): resolved

- `createDefaultConfig` (`src/daemon/config.ts`) writes no `mcp` key. The file has no `mcp` string at all.
- The default comes from the environment. `src/main/mcp/enforcementMode.ts:33`: `const defaultMode: EnforcementMode = opts.isDev ? 'shadow' : 'enforce';`
- `src/main/index.ts:1231`: `const isDevEnvironment = !app.isPackaged || process.env.NODE_ENV === 'development';`. A packaged build is `enforce`. A source run, or `NODE_ENV=development`, is `shadow`.
- A user value overrides this only when it is exactly `shadow` or `enforce` (`enforcementMode.ts` 56-58). Anything else falls back to the environment default.

### 8.2 Launch-line path (section 6, second bullet): partly resolved (the `pty:create` path only)

Order in this path, for a new pane with an initial command:

1. `stageCreate` at `src/main/ipc/handlers/pty.handler.ts:610`.
2. A settle delay, then `attempt` at `scheduleInitialCommand.ts:98`.
3. `beforeWrite`, the folder-trust hold, at `pty.handler.ts:862`: `folderTrustLaunchHold(daemonClient, sessionId, 'startup line', { refuseUnknown: true, once: true })`. If it returns a hold, the write is skipped (`scheduleInitialCommand.ts:93`).
4. `writeLaunchLine` at `pty.handler.ts:853`: `return daemonClient.writeToSession(sessionId, sanitizePtyText(cmd) + '\r');`
5. Only for fan-out or bot task panes: `verifyLaunchLine` checks presence after the write (`pty.handler.ts:867-892`). Its resend gate, `launchPresenceAllowsResend` (`src/daemon/launchPresence.ts:144-146`), runs after the first write, not before it.

`agentLoginGate` is not in this path. Its only consumer found is the automation engine, `src/daemon/automation/AutomationEngine.ts:1021` (`this.ports.signedOut`). It does not gate interactive pane launch.

Still open (see section 8.5): the renderer side of `pane.split` and `surface.new`, which sends `pty:create`.

### 8.3 agentControl holds (section 6, third bullet): partly resolved (who can set a hold is documented intent, not checked code)

- The refusal is `refusal(surfaceId, method)` at `src/main/browser-session/BrowserAgentControl.ts:74-78`. The modes are `'agent' | 'paused' | 'user'` (`src/shared/browserAgentControl.ts:16`).
- The file documents that only the renderer's trusted IPC sets a mode (`BrowserAgentControl.ts` 35-37, documented intent; the enforcing `apply` path at 108 was not read). Agents can read holds; the file says they cannot clear them.
- A hold applies to a browser tab only. `pane.split` has no hold check. `surface.new` has no hold check. A new surface has no entry and starts in `'agent'` mode. The only creation-side refusal is teardown guarding, not creation.

### 8.4 pendingApproval (section 6, fourth bullet): partly resolved

- `pendingApproval` is attached in `src/main/pipe/RpcRouter.ts` 731-747 when all hold: enforce mode, or an always-enforced risk class; a `clientName`; trust `unconfirmed`; non-empty `declaredCapabilities`; and an `approvalQueue`.
- Trust is looked up by `clientName` (`RpcRouter.ts:662-664`). A missing `clientName` gets `legacy` and no prompt.
- `surface.new` requires `wmux.internal` (`methodCapabilityMap.ts:200`). `PermissionEnforcer.ts:422-425` says that reserved name can never be declared, so an external plugin cannot be granted it.
- `pane.split` requires `pane.create` (`methodCapabilityMap.ts:217`). A trusted caller without that grant gets `capability-not-declared` and no prompt.
- The first-party and internal CLI tiers (`firstParty.ts`, `internalCli.ts`) allow both methods without a trust check. Those callers never see `pendingApproval`.
- UNVERIFIED: what approving a prompt for `surface.new` does, and whether production sets `approvalQueue`.

### 8.5 Whole-tree search (section 6, fifth bullet): resolved for the handler files

- Fifty `.ts` files in `src/main/pipe/handlers/` were fetched. Fifteen registrations match `pane.` or `surface.`. Two create: `pane.split` (`pane.rpc.ts:430`, forwards at `:460`) and `surface.new` (`surface.rpc.ts:80`, forwards at `:95`).
- `surface.ensurePty` (`input.rpc.ts:691`, `:1451`) is a renderer call, not a registered method. It starts the shell of a deferred surface.
- UNVERIFIED: the renderer `pty:create` path from `pane.split` and `surface.new` to the launch write. The renderer was not read, so the link between `sendToRenderer` and `pty:create` is not confirmed.

### 8.6 Open after this section

- The renderer link (8.5).
- Whether `approvalQueue` is injected in production, and what approving an unconfirmed `surface.new` prompt does (8.4).
- Whether any writer puts `mcp.mode` into `~/.wmux/config.json` (8.1). Only the reader was checked.
- Whether the MCP or CLI client shows `rejection.pendingApproval` to its caller.
