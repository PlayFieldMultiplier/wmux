// ─── Fan-out requester origin ────────────────────────────────────────────────
//
// Who asked for a fan-out task, recorded on the task's lineage stamp (main,
// `fanout-lineage.json`) at the moment the task pane is created. It holds
// stable ids — the calling pane's paneId and surfaceId, never its ptyId, which
// changes when a surface is rebound to a new PTY after daemon recovery — and a
// snapshot of the pane's display name, so the sidebar can still say who asked
// after that pane is closed.
//
// Never an authority: the depth-1 check reads the owner, not this.
//
// Besides display, it is the ADDRESS of the fan-out caller nudge: when the
// owner workspace has no brain, the pane named here is told its workers moved
// (main/deck/fanoutCallerNotify.ts, renderer/hooks/fanoutCallerNudge.ts). The
// trust it carries is no more than the fan-out's own: the ids were resolved
// from the caller's senderPtyId, the same basis the fan-out's ownership rests
// on. The nudge only uses it inside the owner workspace, re-resolved against
// the live layout before each write (exact surface, no active-tab fallback),
// to a pane whose verified agent passes the delivery eligibility checks, and
// writes one fixed line.

import { BOT_ID_RE } from './bot';

export type FanoutOriginKind = 'pane' | 'orchestrator' | 'gui' | 'bot';

export interface FanoutOrigin {
  kind: FanoutOriginKind;
  /** kind 'pane': the calling pane (stable across PTY rebinds). */
  paneId?: string;
  /** kind 'pane': the calling surface inside that pane. */
  surfaceId?: string;
  /** kind 'pane': the pane's display name when the task launched. */
  label?: string;
  /** kind 'bot': the factory bot that started the fan-out (shared/bot.ts). */
  botId?: string;
  /** kind 'bot': whether the wake that started it carried outside text (set
   *  by main from its own wake state, never from the bot's arguments). */
  tainted?: boolean;
  /** kind 'bot': the starting wake's guest provenance (wakeTaint.ts). */
  guest?: boolean;
  /** kind 'bot': the connections the task's worker reached through main's
   *  signed-in gateway (set by main at dispatch). A row the WorkTask
   *  reconciler mirrors from this stamp keeps them, so the task still reads
   *  as signed-in (shared/ledger.ts taskSignedIn). */
  gatewayConnectors?: string[];
}

/** One task workspace's durable stamp as FANOUT_LINEAGE answers it. `botId`
 *  names the bot whose worker it is (the bot origin, from the stamp or, when
 *  the stamp lacks it, from the task ledger's dispatch record). */
export interface FanoutLineageEntry {
  owner: string;
  at: number;
  origin?: FanoutOrigin;
  botId?: string;
}

const ID_MAX = 128;
const CONNECTOR_NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const LABEL_MAX = 200;

function boundedString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Validate an origin read from disk or handed over IPC. Unknown kinds and
 * non-objects yield undefined; oversized or non-string fields are dropped
 * rather than failing the whole origin. A pane origin with neither a paneId
 * nor a surfaceId can never name its pane, so it yields undefined too — the
 * task then reads as "requester unknown" instead of carrying a dead stamp.
 */
export function sanitizeFanoutOrigin(raw: unknown): FanoutOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'pane' && kind !== 'orchestrator' && kind !== 'gui' && kind !== 'bot') return undefined;
  // A bot origin is nothing without the bot it names.
  if (kind === 'bot') {
    const botId = r['botId'];
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return undefined;
    const gw = r['gatewayConnectors'];
    const gatewayConnectors = Array.isArray(gw) && gw.length > 0 && gw.length <= 8 && gw.every((n) => typeof n === 'string' && CONNECTOR_NAME_RE.test(n)) ? [...gw as string[]] : undefined;
    return {
      kind,
      botId,
      ...(typeof r['tainted'] === 'boolean' ? { tainted: r['tainted'] } : {}),
      ...(typeof r['guest'] === 'boolean' ? { guest: r['guest'] } : {}),
      ...(gatewayConnectors ? { gatewayConnectors } : {}),
    };
  }
  if (kind !== 'pane') return { kind };
  const paneId = boundedString(r['paneId'], ID_MAX);
  const surfaceId = boundedString(r['surfaceId'], ID_MAX);
  const label = boundedString(r['label'], LABEL_MAX);
  if (!paneId && !surfaceId) return undefined;
  return {
    kind,
    ...(paneId ? { paneId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(label ? { label } : {}),
  };
}

export function sameFanoutOrigin(a: FanoutOrigin | undefined, b: FanoutOrigin | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.paneId === b.paneId && a.surfaceId === b.surfaceId && a.label === b.label
    && a.botId === b.botId;
}
