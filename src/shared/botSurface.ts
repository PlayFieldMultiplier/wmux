// ─── Bot role surfaces — the whole power of each role ──────────────────────
//
// A role is defined by what it can call, never by what its prompt forbids.
// Each role has a set of wmux MCP tools (what the bundled server registers in
// `--bot=<role>` mode, src/mcp/index.ts) and the set of pipe RPC methods those
// tools invoke (what RpcRouter lets a bot token reach). RpcRouter refuses any
// other method for a bot token before permission enforcement runs, in every
// enforcement mode; PermissionEnforcer allows exactly this set for a bot.
//
// No role holds a shell, terminal input, pane/surface/workspace teardown, the
// browser or computer use: code is written only by fan-out workers in their
// own worktrees. `pr_verdict` is the verifier's alone; `plan_propose` and
// `bot_list` / `bot_park` are Moa's; Moa has no fan-out.

import type { RpcMethod } from './rpc';
import type { BotBinding, BotRole } from './bot';
import { BOT_RPC } from './bot';
import { FACT_RPC } from './facts';
import { ASK_PERSON_RPC, HANDOFF_RPC } from './handoff';
import { ROOM_RPC } from './room';
import { COMMANDER_TEARDOWN_DENY } from './commanderSurface';

/** Read-side factory RPCs behind the role tools (handlers: WP6). */
export const FACTORY_READ_RPC = {
  prRead: 'pr.read',
  issueRead: 'issue.read',
  ciRead: 'ci.read',
  verdictRead: 'verdict.read',
  trustMetricsRead: 'trustMetrics.read',
} as const;

/** Moa's plan card (handler: WP6). */
export const PLAN_RPC = { propose: 'plan.propose' } as const;

/** Every RPC method the factory adds. Each one is registered in main by
 *  `registerFactoryRpc` (main/factory/factoryHost.ts) with a fail-closed
 *  `not_implemented` handler until the work package that owns it registers
 *  the real one. */
export const FACTORY_RPC_METHODS: readonly RpcMethod[] = [
  FACT_RPC.poll, FACT_RPC.emit,
  BOT_RPC.list, BOT_RPC.create, BOT_RPC.update, BOT_RPC.remove, BOT_RPC.status,
  BOT_RPC.wake, BOT_RPC.park, BOT_RPC.resume, BOT_RPC.interrupt,
  ROOM_RPC.post, ROOM_RPC.read, ROOM_RPC.threads, ROOM_RPC.resolve,
  HANDOFF_RPC.send, HANDOFF_RPC.answer, HANDOFF_RPC.list,
  ASK_PERSON_RPC,
  FACTORY_READ_RPC.prRead, FACTORY_READ_RPC.issueRead, FACTORY_READ_RPC.ciRead,
  FACTORY_READ_RPC.verdictRead, FACTORY_READ_RPC.trustMetricsRead,
  PLAN_RPC.propose,
];

/** Every tool a bot surface may list, with the RPC methods it invokes (the
 *  first one is its primary). The existing names are the tools of the same
 *  name the bundled server already registers; the rest are registered by tool
 *  modules (src/mcp/toolModules.ts). A surface tool no module registers is
 *  served by a placeholder that forwards its arguments to the primary method,
 *  which main answers `not_implemented` until the real handler exists. */
export const BOT_TOOL_RPC = {
  workspace_list: ['workspace.list'],
  pane_list: ['pane.list'],
  terminal_read: ['input.readScreen', 'deck.resolvePaneRoute'],
  fleet_triage: ['fleet.triage'],
  ledger_update: ['ledger.update'],
  fanout_start: ['task.fanout.start'],
  wmux_events_poll: ['events.poll'],
  a2a_task_query: ['a2a.task.query'],
  fact_poll: [FACT_RPC.poll],
  room_post: [ROOM_RPC.post],
  room_read: [ROOM_RPC.read],
  handoff_send: [HANDOFF_RPC.send],
  ask_person: [ASK_PERSON_RPC],
  pr_read: [FACTORY_READ_RPC.prRead],
  issue_read: [FACTORY_READ_RPC.issueRead],
  ci_read: [FACTORY_READ_RPC.ciRead],
  verdict_read: [FACTORY_READ_RPC.verdictRead],
  pr_verdict: ['verify.recordVerdict'],
  trust_metrics_read: [FACTORY_READ_RPC.trustMetricsRead],
  plan_propose: [PLAN_RPC.propose],
  bot_list: [BOT_RPC.list],
  bot_park: [BOT_RPC.park],
} as const satisfies Readonly<Record<string, readonly [RpcMethod, ...RpcMethod[]]>>;

export type BotToolName = keyof typeof BOT_TOOL_RPC;

/** What every bot MCP child calls to come up: the handshake identify, the
 *  capability probe, its own workspace from its token, the process-tree
 *  identity probe, and `#name` pane references. */
export const BOT_BASE_RPC: readonly RpcMethod[] = [
  'mcp.identify',
  'system.identify',
  'system.capabilities',
  'a2a.resolve.identity',
  'deck.resolveCommanderWorkspace',
  'pane.resolveName',
];

export interface RoleSurface {
  tools: ReadonlySet<string>;
  rpc: ReadonlySet<string>;
  /** fan-out presets the role may start (empty: no fan-out). */
  fanoutPresets: readonly string[];
}

/** Tools every role holds. */
const COMMON_TOOLS: readonly BotToolName[] = ['ask_person', 'room_post', 'room_read', 'handoff_send', 'fact_poll'];

const ROLE_TOOLS: Readonly<Record<BotRole, readonly BotToolName[]>> = {
  lead: [
    'workspace_list', 'pane_list', 'terminal_read', 'fleet_triage', 'ledger_update', 'fanout_start',
    'wmux_events_poll', 'a2a_task_query',
  ],
  triage: [
    'workspace_list', 'pane_list', 'terminal_read', 'fleet_triage', 'ledger_update', 'fanout_start',
    'wmux_events_poll', 'a2a_task_query', 'issue_read', 'pr_read', 'verdict_read',
  ],
  verifier: ['fanout_start', 'pr_read', 'verdict_read', 'pr_verdict', 'terminal_read', 'ledger_update'],
  maintainer: ['fanout_start', 'pr_read', 'ledger_update'],
  moa: [
    'workspace_list', 'fleet_triage', 'issue_read', 'pr_read', 'ci_read', 'trust_metrics_read',
    'plan_propose', 'bot_list', 'bot_park',
  ],
};

const ROLE_FANOUT_PRESETS: Readonly<Record<BotRole, readonly string[]>> = {
  lead: ['default'],
  triage: ['repro'],
  verifier: ['verify'],
  maintainer: ['maintain'],
  moa: [],
};

function buildSurface(role: BotRole): RoleSurface {
  const tools = [...ROLE_TOOLS[role], ...COMMON_TOOLS];
  const rpc = new Set<string>(BOT_BASE_RPC);
  for (const tool of tools) for (const method of BOT_TOOL_RPC[tool]) rpc.add(method);
  return {
    tools: new Set<string>(tools),
    rpc,
    fanoutPresets: ROLE_FANOUT_PRESETS[role],
  };
}

export const ROLE_SURFACES: Readonly<Record<BotRole, RoleSurface>> = {
  lead: buildSurface('lead'),
  triage: buildSurface('triage'),
  verifier: buildSurface('verifier'),
  maintainer: buildSurface('maintainer'),
  moa: buildSurface('moa'),
};

/** Teardown-effect methods; on no surface, and refused for every bot token
 *  even if a future surface edit listed one. */
export const BOT_TEARDOWN_DENY: ReadonlySet<string> = COMMANDER_TEARDOWN_DENY;

/** Why RpcRouter refused a bot call, or null when the method is on the bot's
 *  surface. Pure. */
export function botSurfaceRefusal(role: BotRole, method: string): 'teardown' | 'surface' | null {
  if (BOT_TEARDOWN_DENY.has(method)) return 'teardown';
  const surface = ROLE_SURFACES[role];
  if (!surface || !surface.rpc.has(method)) return 'surface';
  return null;
}

/** One refused bot call, as RpcRouter reports it to `onBotRefused` listeners
 *  (the fact log turns it into a `bot.refused` fact). */
export interface BotRefusal {
  at: number;
  bot: BotBinding;
  method: string;
  reason: 'teardown' | 'surface';
}

// ── Typed refusals of factory RPC handlers ──────────────────────────────────

/** Every factory handler answers a refusal as a result, not a thrown error,
 *  in the same `{ok:false, code, message}` shape stage 2's verify.recordVerdict
 *  uses. */
export interface FactoryRefusal<C extends string = string> {
  ok: false;
  code: C;
  message: string;
}

export const FACTORY_NOT_IMPLEMENTED = 'not_implemented' as const;

export type FactoryNotImplemented = FactoryRefusal<typeof FACTORY_NOT_IMPLEMENTED> & { method: string };

export function factoryNotImplemented(method: string): FactoryNotImplemented {
  return {
    ok: false,
    code: FACTORY_NOT_IMPLEMENTED,
    method,
    message: `${method} is not available in this build`,
  };
}
