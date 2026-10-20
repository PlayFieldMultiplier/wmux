// fact.poll / fact.emit — the fact log (shared/facts.ts). Registered here with
// registerFactoryRpcModule (main/factory/factoryHost.ts). The module's start
// opens the log (`<wmuxDir>/factory/facts.jsonl`), publishes it through
// getFactLog() and attaches the ingest sources; dispose detaches them and
// flushes the log.
//
// Who may call:
//   fact.poll — a bot (validated token) or the operator. A bot reads the
//     facts of its own workspace (ctx.bot.workspaceId, never a param) and the
//     facts of the repo its profile acts on (the bot directory, never a
//     param) — merge.* and the repo watch's pr.* / issue.* / ci.*; a
//     Coordinator-template bot (its live profile, COORDINATOR_READ_EXTENSION)
//     and the operator read every fact.
//   fact.emit — the operator only. Bots never write facts directly.

import path from 'node:path';
import type { RpcContext } from '../../../shared/rpc';
import type { FactoryRefusal } from '../../../shared/botSurface';
import {
  FACT_LIMITS,
  FACT_RPC,
  isFactKind,
  type Fact,
  type FactActor,
  type FactDraft,
  type FactKind,
  type FactPollResult,
  type FactRef,
} from '../../../shared/facts';
import { registerFactoryRpcModule } from '../../factory/factoryHost';
import { getBotDirectory } from '../../factory/botStore';
import { isCoordinatorBot } from '../../../shared/bot';
import { normalizeRepoKey } from '../../factory/repoWatch';
import { createFactLog, getFactLog, setFactLog, type FactLog } from '../../factory/factLog';
import { startFactIngest, type FactIngest, type FactIngestPorts } from '../../factory/factIngest';
import { eventBus } from '../../events/EventBus';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { onPrVerdictRecorded } from '../../github/prVerdictStore';
import { factVisibleToBot } from '../../factory/wakeTaint';

const ID_MAX = 256;

function refuse<C extends string>(code: C, message: string): FactoryRefusal<C> {
  return { ok: false, code, message };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

/** The normalized repo a bot's profile acts on, or null (the bot directory). */
export function botRepoKey(botId: string): string | null {
  try {
    return normalizeRepoKey(getBotDirectory()?.get(botId)?.repo?.repoKey);
  } catch {
    return null;
  }
}

/** Whether the bot reads every workspace's facts: its live profile is a
 *  Coordinator's. Unknown bot or no directory: no. */
export function botReadsEverywhere(botId: string): boolean {
  try {
    return isCoordinatorBot(getBotDirectory()?.get(botId));
  } catch {
    return false;
  }
}

export async function handleFactPoll(
  log: Pick<FactLog, 'readWhere' | 'subscribe' | 'latestSeq'> | null,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
  repoOfBot: (botId: string) => string | null = botRepoKey,
  readsEverywhere: (botId: string) => boolean = botReadsEverywhere,
  visibleToBot: (botId: string) => (f: Fact) => boolean = factVisibleToBot,
): Promise<FactPollResult | FactoryRefusal> {
  if (!ctx?.bot && ctx?.operator !== true) return refuse('forbidden', 'fact.poll is for bots and the operator');
  if (!log) return refuse('unavailable', 'the fact log is not running');
  let kinds: Set<FactKind> | null = null;
  if (params.kinds !== undefined) {
    if (!Array.isArray(params.kinds) || !params.kinds.every(isFactKind)) return refuse('invalid', 'kinds must be fact kinds');
    if (params.kinds.length > 0) kinds = new Set(params.kinds);
  }
  if (params.sinceSeq !== undefined && !(typeof params.sinceSeq === 'number' && Number.isSafeInteger(params.sinceSeq) && params.sinceSeq >= 0)) {
    return refuse('invalid', 'sinceSeq must be a non-negative integer');
  }
  // Omitted: start from the newest (only facts appended from now on).
  const since = typeof params.sinceSeq === 'number' ? params.sinceSeq : log.latestSeq();
  const limit = clampInt(params.limit, 1, FACT_LIMITS.POLL_PAGE, FACT_LIMITS.POLL_PAGE);
  const blockMs = clampInt(params.blockMs, 0, FACT_LIMITS.POLL_MAX_BLOCK_MS, 0);
  // Read from the live profile, and again after a blocking wait: a bot no
  // longer a Coordinator when the wait ends reads its own workspace only.
  let everything = ctx.operator === true || (!!ctx.bot && readsEverywhere(ctx.bot.botId));
  // A bot outside a guest-sourced wake reads no fact that may carry a
  // guest's words; judged again after a blocking wait, like the scope.
  let visible = ctx.bot ? visibleToBot(ctx.bot.botId) : (): boolean => true;
  const ownWorkspace = ctx.bot?.workspaceId;
  const ownRepo = ctx.bot ? repoOfBot(ctx.bot.botId) : null;
  const match = (f: Fact): boolean => (
    everything
    || (!!ownWorkspace && f.workspaceId === ownWorkspace)
    || (ownRepo !== null && f.repoKey !== undefined && normalizeRepoKey(f.repoKey) === ownRepo)
  ) && (!kinds || kinds.has(f.kind)) && visible(f);

  let r = log.readWhere(since, match, limit);
  if (r.facts.length === 0 && blockMs > 0 && !ctx.signal?.aborted) {
    const after = r.lastSeq;
    await new Promise<void>((resolve) => {
      let off: (() => void) | null = null;
      const done = (): void => {
        clearTimeout(timer);
        off?.();
        ctx.signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, blockMs);
      ctx.signal?.addEventListener('abort', done, { once: true });
      off = log.subscribe((f) => {
        if (f.seq > after && match(f)) done();
      });
    });
    if (ctx.bot) {
      everything = readsEverywhere(ctx.bot.botId);
      visible = visibleToBot(ctx.bot.botId);
    }
    r = log.readWhere(after, match, limit);
  }
  return { ok: true, facts: r.facts, nextSeq: r.lastSeq };
}

const REF_NUMBERS = new Set(['pr', 'issue']);
const REF_STRINGS = new Set(['headSha', 'taskId', 'botId', 'handoffId', 'check', 'ptyId', 'label', 'scheduleId', 'method', 'messageId']);
const ACTOR_KINDS = new Set<FactActor['kind']>(['system', 'bot', 'human', 'github']);
const DRAFT_KEYS = new Set(['kind', 'at', 'workspaceId', 'repoKey', 'ref', 'actor', 'payload']);

/** A fact.emit draft, strictly: unknown keys and malformed fields refuse. */
export function parseFactDraft(raw: Record<string, unknown>, now: number): { ok: true; draft: FactDraft } | { ok: false; message: string } {
  for (const k of Object.keys(raw)) if (!DRAFT_KEYS.has(k)) return { ok: false, message: `unknown field ${k}` };
  if (!isFactKind(raw.kind)) return { ok: false, message: 'kind must be a fact kind' };
  if (raw.at !== undefined && !(typeof raw.at === 'number' && Number.isFinite(raw.at))) return { ok: false, message: 'at must be a number' };
  if (raw.workspaceId !== undefined && !isId(raw.workspaceId)) return { ok: false, message: 'workspaceId must be an id' };
  if (raw.repoKey !== undefined && !isId(raw.repoKey)) return { ok: false, message: 'repoKey must be an id' };
  let ref: FactRef | undefined;
  if (raw.ref !== undefined) {
    if (!isRecord(raw.ref)) return { ok: false, message: 'ref must be an object' };
    for (const [k, v] of Object.entries(raw.ref)) {
      if (REF_NUMBERS.has(k) ? !(typeof v === 'number' && Number.isSafeInteger(v) && v > 0) : !(REF_STRINGS.has(k) && isId(v))) {
        return { ok: false, message: `ref.${k} is not valid` };
      }
    }
    ref = raw.ref as FactRef;
  }
  let actor: FactActor = { kind: 'human' };
  if (raw.actor !== undefined) {
    const a = raw.actor;
    if (!isRecord(a) || !ACTOR_KINDS.has(a.kind as FactActor['kind']) || (a.id !== undefined && !isId(a.id))
      || Object.keys(a).some((k) => k !== 'kind' && k !== 'id')) {
      return { ok: false, message: 'actor is not valid' };
    }
    actor = { kind: a.kind as FactActor['kind'], ...(a.id !== undefined ? { id: a.id as string } : {}) };
  }
  if (raw.payload !== undefined && !isRecord(raw.payload)) return { ok: false, message: 'payload must be an object' };
  return {
    ok: true,
    draft: {
      kind: raw.kind,
      at: typeof raw.at === 'number' ? raw.at : now,
      ...(raw.workspaceId !== undefined ? { workspaceId: raw.workspaceId as string } : {}),
      // One spelling per repository, so the dedupe key and the thread match
      // the facts repo watch writes; a value that is no repo key is kept.
      ...(raw.repoKey !== undefined ? { repoKey: normalizeRepoKey(raw.repoKey) ?? (raw.repoKey as string) } : {}),
      ...(ref ? { ref } : {}),
      actor,
      payload: (raw.payload as Record<string, unknown> | undefined) ?? {},
    },
  };
}

export async function handleFactEmit(
  log: Pick<FactLog, 'appendResult'> | null,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
  now: () => number = Date.now,
): Promise<{ ok: true; fact: Fact } | FactoryRefusal> {
  if (ctx?.operator !== true || ctx.bot) return refuse('forbidden', 'fact.emit is for the operator only');
  if (!log) return refuse('unavailable', 'the fact log is not running');
  const parsed = parseFactDraft(params, now());
  if (!parsed.ok) return refuse('invalid', parsed.message);
  const r = log.appendResult(parsed.draft);
  if (r.ok) return { ok: true, fact: r.fact };
  const messages = {
    invalid: 'the fact lacks the fields its dedupe key needs',
    too_large: `the payload is over ${FACT_LIMITS.PAYLOAD_MAX_BYTES} bytes`,
    duplicate: 'a fact with the same dedupe key is already in the log',
    write_failed: 'the fact could not be written',
    stopped: 'the fact log is not running',
  } as const;
  return refuse(r.code, messages[r.code]);
}

/** The production sources (singletons). */
export function defaultFactIngestPorts(): FactIngestPorts {
  const ledger = getTaskLedger();
  return {
    subscribeBus: (fn) => eventBus.subscribe(fn),
    findTaskByWorkspace: (ws) => ledger.findByTaskWorkspace(ws),
    onLedgerTransition: (fn) => ledger.onTransition(fn),
    onVerdictRecorded: onPrVerdictRecorded,
  };
}

registerFactoryRpcModule('facts', (router, deps) => {
  let log: FactLog | null = null;
  let ingest: FactIngest | null = null;
  // Subscribed here (register time); forwards once the ingest runs.
  router.onBotRefused((r) => ingest?.noteBotRefused(r));
  router.register(FACT_RPC.poll, (params, ctx) => handleFactPoll(log, params, ctx));
  router.register(FACT_RPC.emit, (params, ctx) => handleFactEmit(log, params, ctx));
  return {
    start() {
      const next = createFactLog(path.join(deps.wmuxDir(), 'factory'));
      next.start();
      log = next;
      setFactLog(next);
      ingest = startFactIngest(next, defaultFactIngestPorts());
    },
    dispose() {
      ingest?.dispose();
      ingest = null;
      if (log && getFactLog() === log) setFactLog(null);
      log?.dispose();
      log = null;
    },
  };
});
