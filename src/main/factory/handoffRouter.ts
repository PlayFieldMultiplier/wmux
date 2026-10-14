// ─── Handoff router — typed messages between bots and the owner ────────────
//
// A bot sends a typed handoff (shared/handoff.ts); the router, not the model,
// decides everything else:
//
//   addressee  toBotId (a message, or a dispatch naming one) → that bot, in
//              any workspace (enabled, never the sender); dispatch → the
//              enabled lead of the target workspace; result / refusal → the
//              sender of the handoff it replies to, else its own workspace's
//              lead; ask_person → the owner; answer → the bot that asked. A
//              workspace's lead is its oldest enabled coordinator (other
//              than the sender), else its oldest enabled bot stored with the
//              `lead` role. A
//              room card's `mentions` are messages (mention()), woken as
//              `mention` wakes.
//   thread     the param's thread, else the parent's, else the thread of the
//              wake the sender is running, else `handoff:<id>` (main pins
//              where an answer lands, not the model).
//   chain      runId and attribution come from the parent: the replyTo, else
//              the handoff the sender's running wake delivers (for a task
//              wake, the one its tasks were started for; for the answer to a
//              question asked mid-hop, that hop), else the run of
//              the owner's message the running wake carries (every bot that
//              message woke shares it); a send with none of these starts a
//              run. depth is 1 for a hop with no parent and +1 per bot→bot
//              hop; hopsInRun is one past the highest hop of the run that was
//              not refused. depth > HANDOFF_LIMITS.MAX_DEPTH is refused, and
//              so is hopsInRun > MAX_PER_RUN — except an owner run's first
//              hops (no parent), which the owner's message bounds — and a
//              send past MAX_PER_RUN within one turn of a bot.
//
// A result (or refusal) answers its replyTo at most once: a second one is
// refused `duplicate_result`. A send or question carrying a clientHandoffId
// the sender already used (default `wake:<wakeId>:h<n>` from its running
// wake) returns the first one's outcome, marked `duplicate`, and sends
// nothing — a retried turn cannot hand off twice.
//
// Every refusal is a stored handoff (status `refused`), a `handoff.refused`
// fact and a room card. Delivery has one owner, the router: a priority-1
// wake of the addressee carrying the handoff id, then a `handoff.received`
// fact whose ref.botId is the addressee (for the room and for readers; the
// default role triggers do not wake on it). A wake the queue does not take is
// a failed hop and is refused the same way. The handoff is marked delivered
// only once its wake is on disk; one stored but not marked delivered when the
// app stopped is delivered again on the next start, into the same wake (the
// queue keys a handoff wake by its handoff id, so it never runs twice). The
// answer to a question always reaches the bot that asked: its wake may go
// past the addressee's queue cap (wakeQueue.ts OVER_CAP_RESERVE).
//
// ask_person lands as a WorkspaceDecision in its thread (deckDecisionStore
// v2, origin `ask_person`) plus a `question` card. A thread holds one open
// decision: a second question to a busy thread waits (status `queued`) and is
// raised when the thread frees, so a bot never has to poll and retry. Answers
// are taken from the decision store whichever path resolved the decision
// (room.resolve, handoff.answer, the deck card, the phone): on every decision
// change the router turns a resolved ask into an `answer` handoff to the bot
// that asked, and clears the decision so the thread frees. A question open
// longer than ASK_PERSON_TTL_MS, or whose decision disappeared, expires.
//
// Persistence: `<wmuxDir>/factory/handoffs.jsonl`, one Handoff per line, a
// status change appends the record again and the last line of an id wins. A
// change that did not reach the file is not made in memory either.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicReadJSONSync, atomicWriteTextSync } from '../../daemon/util/atomicWrite';
import { redactStoredSecretsDeep } from './secretRedaction';
import { BOT_ID_RE, isBotRole, isCoordinatorBot, type BotBinding, type BotProfile } from '../../shared/bot';
import { SHARED_SURFACE, type BotToolName } from '../../shared/botSurface';
import type { Fact, FactDraft, FactRef } from '../../shared/facts';
import type { WakeItem, WakeReason } from '../../shared/wake';
import {
  HANDOFF_LIMITS,
  type AskPersonParams,
  type Handoff,
  type HandoffKind,
  type HandoffListParams,
  type HandoffRefusalCode,
  type HandoffSendParams,
  type HandoffStatus,
  type Party,
} from '../../shared/handoff';
import { ROOM_LIMITS, parseThreadId, type RoomCard, type ThreadId } from '../../shared/room';
import {
  DECISION_LIMITS,
  clearThreadDecision,
  loadThreadDecision,
  loadWorkspaceDecisions,
  onDecisionsChanged,
  raiseThreadDecisionIfFree,
  resolveThreadDecision,
  type WorkspaceDecision,
} from '../deck/deckDecisionStore';
import {
  appendJsonLines,
  capBody,
  emitHumanCorrection,
  isClientId,
  isRoomWorkspaceId,
  oneLine,
  runningWake,
  runningWakeThread,
  sanitizeParty,
  sanitizeRefs,
  wakeOrdinals,
  wakeReplyTo,
  writeFactCards,
  type FactoryRoomPorts,
  type RoomWriter,
} from './roomWriter';

export const HANDOFFS_FILENAME = 'handoffs.jsonl';
export const LEGACY_MOA_HANDOFFS_FILENAME = 'moa-handoffs.json';

export const HANDOFF_STORE_LIMITS = {
  /** Records kept (open asks are never pruned before their TTL). */
  MAX_RECORDS: 2000,
  /** A closed handoff is kept this long after its last change. */
  RETAIN_MS: 30 * 24 * 3600_000,
  /** Superseded lines tolerated before the file is rewritten. */
  COMPACT_SLACK: 1000,
  /** Open (queued or raised) questions one workspace may hold. */
  OPEN_ASKS_PER_WORKSPACE: 20,
  TITLE_MAX: ROOM_LIMITS.TITLE_MAX,
  BODY_MAX: ROOM_LIMITS.CARD_BODY_MAX,
  /** An answer as the wake and the fact carry it. */
  ANSWER_MAX: DECISION_LIMITS.MAX_RESOLUTION_CHARS,
  CHAIN_MAX: 50,
  LIST_DEFAULT: 50,
  LIST_MAX: 200,
} as const;

/** The answer text of a question the owner closed without choosing. */
export const DISMISSED_ANSWER = 'The owner closed this question without choosing an answer.';

const HANDOFF_KINDS: readonly HandoffKind[] = ['dispatch', 'result', 'ask_person', 'answer', 'refusal', 'message'];
const HANDOFF_STATUSES: readonly HandoffStatus[] = ['queued', 'delivered', 'answered', 'refused', 'expired'];
const REFUSAL_CODES: readonly HandoffRefusalCode[] = ['max_depth', 'max_per_run', 'no_addressee', 'surface', 'budget', 'duplicate_result'];
const LANDINGS: readonly Handoff['landing'][] = ['room', 'room+phone', 'wake'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

// ── Results ────────────────────────────────────────────────────────────────

export interface HandoffAddressee { botId: string; role: string; workspaceId: string; }

export type HandoffResult =
  | {
      ok: true;
      handoffId: string;
      status: HandoffStatus;
      threadId: ThreadId;
      to?: HandoffAddressee;
      wakeId?: string;
      /** ask_person: the decision the question is, once raised. */
      decisionId?: string;
      /** ask_person: the open decision a queued question waits behind. */
      queuedBehind?: string;
      /** handoff.answer: the answer handoff sent to the bot that asked. */
      answerHandoffId?: string;
      /** The clientHandoffId was used before: this is that handoff. */
      duplicate?: true;
    }
  | {
      ok: false;
      code: HandoffRefusalCode | 'invalid' | 'not_found' | 'not_pending' | 'write_failed';
      message: string;
      /** Set when the refusal was recorded as a handoff. */
      handoffId?: string;
      duplicate?: true;
    };

/** A handoff as the bot's wake prompt shows it (BotRuntime
 *  `resolveHandoff` → WakeHandoffSummary). */
export interface HandoffWakeSummary {
  handoffId: string; kind: string; from: string; title: string; body: string;
  /** It carries the owner's words (an answer): a budget refusal holds its wake. */
  ownerWords?: boolean;
  /** An answer the owner gave by closing the question, with no words of
   *  their own. */
  dismissed?: true;
  /** The sender's workspace, when the sender is a bot. */
  fromWorkspaceId?: string;
  /** It already has its result. */
  answered?: true;
}

// ── Decision store port (the real store, bound to one data dir) ────────────

export interface AskDecisionPort {
  forWorkspace(workspaceId: string): WorkspaceDecision[];
  inThread(workspaceId: string, threadId: ThreadId): WorkspaceDecision | null;
  raise(workspaceId: string, threadId: ThreadId, args: { question: string; options?: string[]; context?: string; handoffId: string }): Promise<WorkspaceDecision | null>;
  resolve(workspaceId: string, id: string, answer: string): Promise<WorkspaceDecision | null>;
  clear(workspaceId: string, threadId: ThreadId, expectedId: string): Promise<boolean>;
  onChanged(fn: () => void): () => void;
}

export function deckDecisionPort(dir: string): AskDecisionPort {
  return {
    forWorkspace: (ws) => loadWorkspaceDecisions(ws, dir),
    inThread: (ws, t) => loadThreadDecision(ws, t, dir),
    raise: (ws, t, a) => raiseThreadDecisionIfFree(
      ws, t,
      { question: a.question, options: a.options, context: a.context, origin: 'ask_person', ref: a.handoffId, handoffId: a.handoffId },
      dir,
    ),
    resolve: (ws, id, answer) => resolveThreadDecision(ws, id, answer, { resolvedBy: 'human' }, dir),
    clear: (ws, t, id) => clearThreadDecision(ws, t, id, dir),
    onChanged: onDecisionsChanged,
  };
}

// ── Parsing (pure) ─────────────────────────────────────────────────────────

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e6;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

function sanitizeOptions(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((o) => oneLine(o, DECISION_LIMITS.MAX_OPTION_CHARS))
    .filter((o) => o.length > 0)
    .slice(0, DECISION_LIMITS.MAX_OPTIONS);
  return out.length > 0 ? out : undefined;
}

/** A handoff read from disk, or null when it is not a well-formed one. */
export function parseHandoff(raw: unknown): Handoff | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (h.version !== 1 || typeof h.id !== 'string' || !ID_RE.test(h.id)) return null;
  if (typeof h.runId !== 'string' || !ID_RE.test(h.runId)) return null;
  const threadId = parseThreadId(h.threadId);
  const from = sanitizeParty(h.from);
  const to = sanitizeParty(h.to);
  if (!threadId || !from || !to || !nonNegInt(h.depth) || !nonNegInt(h.hopsInRun)) return null;
  if (!oneOf(HANDOFF_KINDS, h.kind) || !oneOf(HANDOFF_STATUSES, h.status) || !oneOf(LANDINGS, h.landing)) return null;
  if (!finiteNumber(h.createdAt) || !finiteNumber(h.updatedAt)) return null;
  const attr = h.attribution as Record<string, unknown> | undefined;
  const originator = sanitizeParty(attr?.originator);
  if (!originator || !Array.isArray(attr?.chain)) return null;
  const chain = (attr.chain as unknown[]).filter((c): c is string => typeof c === 'string' && ID_RE.test(c)).slice(-HANDOFF_STORE_LIMITS.CHAIN_MAX);
  const p = h.payload as Record<string, unknown> | undefined;
  const title = oneLine(p?.title, HANDOFF_STORE_LIMITS.TITLE_MAX);
  if (!title) return null;
  const refs = sanitizeRefs(p?.refs);
  const options = sanitizeOptions(p?.options);
  const r = h.refusal as Record<string, unknown> | undefined;
  const refusal = r && oneOf(REFUSAL_CODES, r.code) ? { code: r.code, detail: oneLine(r.detail, 500) } : undefined;
  return {
    version: 1,
    id: h.id,
    runId: h.runId,
    threadId,
    depth: h.depth,
    hopsInRun: h.hopsInRun,
    from,
    to,
    kind: h.kind,
    ...(typeof h.replyTo === 'string' && ID_RE.test(h.replyTo) ? { replyTo: h.replyTo } : {}),
    attribution: { originator, chain },
    landing: h.landing,
    payload: {
      title,
      body: capBody(p?.body, HANDOFF_STORE_LIMITS.BODY_MAX),
      ...(refs ? { refs: refs as FactRef } : {}),
      ...(options ? { options } : {}),
    },
    status: h.status,
    ...(refusal ? { refusal } : {}),
    ...(isClientId(h.clientHandoffId) ? { clientHandoffId: h.clientHandoffId } : {}),
    ...(h.intro === true && h.kind === 'ask_person' ? { intro: true as const } : {}),
    ...(h.kind === 'ask_person' && typeof h.ownerCardId === 'string' && ID_RE.test(h.ownerCardId) ? { ownerCardId: h.ownerCardId } : {}),
    ...(h.kind === 'ask_person' && typeof h.forHop === 'string' && ID_RE.test(h.forHop) ? { forHop: h.forHop } : {}),
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function isOpenAsk(h: Handoff): boolean {
  return h.kind === 'ask_person' && (h.status === 'queued' || h.status === 'delivered');
}

/** What a send or a mention routes (validated by its entry point). */
interface RouteSpec {
  kind: 'dispatch' | 'result' | 'refusal' | 'message';
  title: string;
  body: unknown;
  refs?: FactRef;
  namedThread?: ThreadId;
  replyTo?: string;
  toWorkspaceId?: string;
  toBotId?: string;
  clientHandoffId?: string;
}

/** The idempotency key of the message a card's mention sends one bot. */
export function mentionKey(cardId: string, botId: string): string {
  return `mention:${cardId}:${botId}`;
}

function botParty(b: BotBinding): Party {
  return { kind: 'bot', workspaceId: b.workspaceId, botId: b.botId };
}

/** The tool is on the bot surface, for a binding whose role tag is one (a
 *  malformed binding holds nothing). */
function surfaceAllows(b: BotBinding, tool: BotToolName): boolean {
  return isBotRole(b.role) && SHARED_SURFACE.tools.has(tool);
}

// ── Store + router ─────────────────────────────────────────────────────────

export interface HandoffRouterOptions {
  /** `<wmuxDir>/factory/handoffs.jsonl` */
  file: string;
  decisions: AskDecisionPort;
  /** fact log, wake queue, bot directory (resolved on use). */
  ports: () => Partial<Pick<FactoryRoomPorts, 'factLog' | 'wakes' | 'bots' | 'currentWakeThread' | 'currentWake'>>;
  rooms: () => RoomWriter | null;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export class HandoffRouter {
  private readonly records = new Map<string, Handoff>();
  private lines = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private offDecisions: (() => void) | null = null;
  /** Handoffs delivered per turn (`<wakeId>#<attempt>`). */
  private readonly sentInTurn = new Map<string, number>();
  /** Deliveries waiting for their wake to reach the disk. */
  private readonly settling = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(private readonly opts: HandoffRouterOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m, e) => console.warn(`[factory] handoffs: ${m}`, e ?? ''));
  }

  // ── lifecycle ──

  /** Load the file, follow the decision store and settle what changed while
   *  the app was off (answers given on the phone, expiries, queued asks). */
  async start(): Promise<void> {
    this.load();
    this.redeliverQueued();
    this.offDecisions ??= this.opts.decisions.onChanged(() => {
      // The store notifies inside its write: settle on our own chain.
      void this.reconcile();
    });
    await this.reconcile();
  }

  dispose(): void {
    this.offDecisions?.();
    this.offDecisions = null;
  }

  /** Resolves once every delivery so far is marked (or left queued). */
  async idle(): Promise<void> {
    while (this.settling.size > 0) await Promise.all([...this.settling]);
  }

  private load(): void {
    this.records.clear();
    this.lines = 0;
    let text = '';
    try {
      text = fs.readFileSync(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log('handoffs unreadable; starting empty', err);
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.lines += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const h = parseHandoff(raw);
      if (h) this.records.set(h.id, h);
    }
    const before = this.records.size;
    this.prune();
    if (this.records.size < before || this.lines - this.records.size >= HANDOFF_STORE_LIMITS.COMPACT_SLACK) this.compact();
  }

  private prune(): void {
    const cutoff = this.now() - HANDOFF_STORE_LIMITS.RETAIN_MS;
    for (const [id, h] of this.records) if (!isOpenAsk(h) && h.updatedAt < cutoff) this.records.delete(id);
    const over = this.records.size - HANDOFF_STORE_LIMITS.MAX_RECORDS;
    if (over > 0) {
      const closed = [...this.records.values()].filter((h) => !isOpenAsk(h)).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const h of closed.slice(0, over)) this.records.delete(h.id);
    }
  }

  private compact(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      const text = [...this.records.values()].map((h) => JSON.stringify(h)).join('\n');
      atomicWriteTextSync(this.opts.file, text ? `${text}\n` : '');
      this.lines = this.records.size;
    } catch (err) {
      this.log('handoffs not compacted', err);
    }
  }

  /** Store a new version of a handoff (a fresh object). Durable first:
   *  false when the line did not reach the file, and memory is unchanged. */
  private put(next: Handoff): boolean {
    // A stored bot secret never lands in a handoff (secretRedaction.ts); the
    // caller's object carries the redacted text on from here.
    const clean = redactStoredSecretsDeep(next);
    if (clean !== next) Object.assign(next, clean);
    next.updatedAt = this.now();
    try {
      appendJsonLines(this.opts.file, [JSON.stringify(next)]);
      this.lines += 1;
    } catch (err) {
      this.log(`handoff ${next.id} not persisted`, err);
      return false;
    }
    this.records.set(next.id, next);
    if (this.records.size > HANDOFF_STORE_LIMITS.MAX_RECORDS) {
      this.prune();
      this.compact();
    } else if (this.lines - this.records.size >= HANDOFF_STORE_LIMITS.COMPACT_SLACK) {
      this.compact();
    }
    return true;
  }

  /** Deliver what was stored but not delivered when the app stopped. */
  private redeliverQueued(): void {
    for (const h of [...this.records.values()]) {
      if (h.status !== 'queued' || h.kind === 'ask_person' || h.to.kind !== 'bot') continue;
      const bot = safeGet(this.opts.ports().bots, h.to.botId);
      if (!bot || !bot.enabled) this.refuse(h, 'no_addressee', `bot ${h.to.botId} is not enabled`);
      else this.deliver(h, bot);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ── reads ──

  get(id: string): Handoff | null {
    const h = this.records.get(id);
    return h ? structuredClone(h) : null;
  }

  list(params: HandoffListParams = {}): Handoff[] {
    const limit = Math.max(1, Math.min(HANDOFF_STORE_LIMITS.LIST_MAX, Math.floor(params.limit ?? HANDOFF_STORE_LIMITS.LIST_DEFAULT)));
    const statuses = Array.isArray(params.status) ? params.status.filter((s) => oneOf(HANDOFF_STATUSES, s)) : null;
    return [...this.records.values()]
      .filter((h) => !params.workspaceId || partyWorkspace(h.from) === params.workspaceId || partyWorkspace(h.to) === params.workspaceId)
      .filter((h) => !statuses || statuses.length === 0 || statuses.includes(h.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((h) => structuredClone(h));
  }

  /** The handoff as a bot's wake shows it, or null. */
  summarize(id: string): HandoffWakeSummary | null {
    const h = this.records.get(id);
    if (!h) return null;
    return {
      handoffId: h.id, kind: h.kind, from: this.partyLabel(h.from), title: h.payload.title, body: h.payload.body,
      ...(h.kind === 'answer' ? { ownerWords: true } : {}),
      ...(h.kind === 'answer' && h.from.kind === 'human' && h.payload.body === DISMISSED_ANSWER ? { dismissed: true as const } : {}),
      ...(h.from.kind === 'bot' ? { fromWorkspaceId: h.from.workspaceId } : {}),
      ...(this.answered(h.id) ? { answered: true as const } : {}),
    };
  }

  // ── send (dispatch / result / refusal / message) ──

  /** A bot sends a dispatch, result, refusal or message. Synchronous: the
   *  hop count and the record are settled before anything else runs. */
  send(sender: BotBinding, params: HandoffSendParams): HandoffResult {
    const kind = params?.kind;
    if (kind !== 'dispatch' && kind !== 'result' && kind !== 'refusal' && kind !== 'message') {
      return invalid('kind must be dispatch, result, refusal or message');
    }
    const title = oneLine(params.title, HANDOFF_STORE_LIMITS.TITLE_MAX);
    if (!title) return invalid('title is required');
    const namedThread = params.threadId === undefined ? undefined : parseThreadId(params.threadId);
    if (namedThread === null) return invalid('threadId is not a thread id');
    if (params.toWorkspaceId !== undefined && !isRoomWorkspaceId(params.toWorkspaceId)) return invalid('toWorkspaceId is not a workspace id');
    if (params.toBotId !== undefined && (typeof params.toBotId !== 'string' || !BOT_ID_RE.test(params.toBotId))) return invalid('toBotId is not a bot id');
    if (kind === 'message' && params.toBotId === undefined) return invalid('a message needs toBotId');
    if (params.toBotId !== undefined && kind !== 'message' && kind !== 'dispatch') return invalid('toBotId is for a dispatch or a message');
    if (params.replyTo !== undefined && (typeof params.replyTo !== 'string' || !ID_RE.test(params.replyTo))) return invalid('replyTo is not a handoff id');
    if (params.clientHandoffId !== undefined && (!isClientId(params.clientHandoffId) || params.clientHandoffId.startsWith('mention:'))) {
      return invalid('clientHandoffId is not a valid key');
    }
    const wake = runningWake(this.opts.ports(), sender.botId);
    return this.route(sender, {
      kind,
      title,
      body: params.body,
      refs: sanitizeRefs(params.refs) as FactRef | undefined,
      namedThread,
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
      ...(params.toWorkspaceId !== undefined ? { toWorkspaceId: params.toWorkspaceId } : {}),
      ...(params.toBotId !== undefined ? { toBotId: params.toBotId } : {}),
      clientHandoffId: params.clientHandoffId ?? wakeOrdinals.next(wake, 'handoff'),
    });
  }

  /**
   * A bot's room card named other bots (room.post `mentions`): one `message`
   * handoff per bot, in the poster's chain, so the depth and per-run caps
   * hold, each delivered as a `mention` wake. Keyed by card and bot
   * (`mention:<cardId>:<botId>`): the same card never wakes a bot twice,
   * across a retried turn or a restart. The caller has dropped the poster
   * itself; an unknown or disabled bot is refused `no_addressee`.
   */
  mention(sender: BotBinding, card: Pick<RoomCard, 'id' | 'threadId' | 'title' | 'body' | 'refs'>, botIds: readonly string[]): Array<{ botId: string; result: HandoffResult }> {
    const refs = sanitizeRefs({ pr: card.refs?.pr, issue: card.refs?.issue, headSha: card.refs?.headSha, taskId: card.refs?.taskId, url: card.refs?.url, messageId: card.id });
    return botIds.map((botId) => ({
      botId,
      result: this.route(sender, {
        kind: 'message',
        title: oneLine(card.title, HANDOFF_STORE_LIMITS.TITLE_MAX) || 'message',
        body: card.body ?? '',
        refs: refs as FactRef | undefined,
        namedThread: card.threadId,
        toBotId: botId,
        clientHandoffId: mentionKey(card.id, botId),
      }),
    }));
  }

  private route(sender: BotBinding, spec: RouteSpec): HandoffResult {
    const { kind } = spec;
    const ports = this.opts.ports();
    const wake = runningWake(ports, sender.botId);
    const prior = this.byClientId(sender.botId, spec.clientHandoffId);
    if (prior) return prior.kind === 'ask_person' ? invalid('clientHandoffId was used for a question') : this.resultOf(prior, true);

    // The chain continues from the replyTo, else from the handoff the
    // running wake delivers (addressed to this bot), else the owner's message
    // the running wake carries, so leaving replyTo out never resets depth or
    // the hop count; a result or refusal without a replyTo answers that
    // handoff.
    const ownWoken = spec.replyTo ? null : this.wokenHop(sender.botId, wake?.handoffId);
    const parent = spec.replyTo ? this.records.get(spec.replyTo) ?? null : kind === 'result' || kind === 'refusal' ? ownWoken : null;
    const chainParent = parent ?? ownWoken;
    // A bot woken by the owner's message speaks for that message: its
    // handoffs join the message's run, as its first bot-to-bot hops.
    const ownerRun = !chainParent && wake?.runId && ID_RE.test(wake.runId) ? wake.runId : null;
    const from = botParty(sender);
    const id = newId('h');
    // A chain a Coordinator starts begins at depth 0, like the owner's.
    const depth = chainParent ? chainParent.depth + 1 : isCoordinatorBot(safeGet(this.opts.ports().bots, sender.botId)) ? 0 : 1;
    const runId = chainParent ? chainParent.runId : ownerRun ?? newId('run');
    const draft: Handoff = {
      version: 1,
      id,
      runId,
      threadId: spec.namedThread ?? parent?.threadId ?? runningWakeThread(ports, sender.botId)
        ?? chainParent?.threadId ?? (`handoff:${id}` as ThreadId),
      depth,
      hopsInRun: Math.max(this.hopsIn(runId), chainParent?.hopsInRun ?? 0) + 1,
      from,
      to: { kind: 'system' },
      kind,
      ...(parent ? { replyTo: parent.id } : {}),
      attribution: chainParent
        ? { originator: chainParent.attribution.originator, chain: [...chainParent.attribution.chain, chainParent.id].slice(-HANDOFF_STORE_LIMITS.CHAIN_MAX) }
        : { originator: ownerRun ? { kind: 'human' } : from, chain: [] },
      landing: 'wake',
      payload: {
        title: spec.title,
        body: capBody(spec.body, HANDOFF_STORE_LIMITS.BODY_MAX),
        ...(spec.refs ? { refs: spec.refs } : {}),
      },
      status: 'queued',
      ...(spec.clientHandoffId ? { clientHandoffId: spec.clientHandoffId } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
    };

    if (!surfaceAllows(sender, 'handoff_send')) return this.refuse(draft, 'surface', 'the bot surface has no handoff_send');
    if (spec.replyTo && !parent) return this.refuse(draft, 'no_addressee', `no handoff ${spec.replyTo} to reply to`);
    if (parent && !(parent.to.kind === 'bot' && parent.to.botId === sender.botId)) {
      return this.refuse(draft, 'surface', 'a reply goes only to a handoff addressed to you');
    }
    if (parent && (kind === 'result' || kind === 'refusal') && this.answered(parent.id)) {
      return this.refuse(draft, 'duplicate_result', `handoff ${parent.id} already has its result`);
    }

    const target = this.addresseeFor(sender, kind, parent, spec.toWorkspaceId, spec.toBotId);
    if ('refusal' in target) return this.refuse(draft, target.refusal, target.detail);
    draft.to = { kind: 'bot', workspaceId: target.bot.workspaceId, botId: target.bot.id };

    if (depth > HANDOFF_LIMITS.MAX_DEPTH) {
      return this.refuse(draft, 'max_depth', `chain depth ${depth} is over ${HANDOFF_LIMITS.MAX_DEPTH}`);
    }
    // The first hops of an owner's run (the bots it woke answering each
    // other) are never refused here; they count for the hops after them.
    if (!ownerRun && draft.hopsInRun > HANDOFF_LIMITS.MAX_PER_RUN) {
      return this.refuse(draft, 'max_per_run', `hop ${draft.hopsInRun} of run ${runId} is over ${HANDOFF_LIMITS.MAX_PER_RUN}`);
    }
    // One turn starts at most MAX_PER_RUN handoffs, parentless ones included.
    const turnKey = wake ? `${wake.wakeId}#${wake.attempt}` : null;
    const inTurn = turnKey ? this.sentInTurn.get(turnKey) ?? 0 : 0;
    if (turnKey && inTurn >= HANDOFF_LIMITS.MAX_PER_RUN) {
      return this.refuse(draft, 'max_per_run', `one turn sends at most ${HANDOFF_LIMITS.MAX_PER_RUN} handoffs`);
    }
    const result = this.deliver(draft, target.bot);
    if (turnKey && result.ok) {
      this.sentInTurn.delete(turnKey);
      this.sentInTurn.set(turnKey, inTurn + 1);
      if (this.sentInTurn.size > 1000) {
        const oldest = this.sentInTurn.keys().next().value;
        if (oldest !== undefined) this.sentInTurn.delete(oldest);
      }
    }
    return result;
  }

  private addresseeFor(
    sender: BotBinding,
    kind: 'dispatch' | 'result' | 'refusal' | 'message',
    parent: Handoff | null,
    toWorkspaceId: string | undefined,
    toBotId: string | undefined,
  ): { bot: BotProfile } | { refusal: HandoffRefusalCode; detail: string } {
    const bots = this.opts.ports().bots;
    if (!bots) return { refusal: 'no_addressee', detail: 'the bot directory is not available' };
    if (toBotId !== undefined) {
      // Any bot, in any workspace: messaging is every bot's.
      if (toBotId === sender.botId) return { refusal: 'no_addressee', detail: 'a bot does not message itself' };
      const bot = safeGet(bots, toBotId);
      if (!bot || !bot.enabled) return { refusal: 'no_addressee', detail: `bot ${toBotId} is not enabled` };
      return { bot };
    }
    if (kind === 'dispatch') {
      // Messaging another workspace is every bot's power.
      const ws = toWorkspaceId ?? sender.workspaceId;
      const lead = this.leadOf(bots, ws, sender.botId);
      if (!lead) return { refusal: 'no_addressee', detail: `workspace ${ws} has no enabled lead` };
      if (lead.id === sender.botId) return { refusal: 'no_addressee', detail: 'the sender is that workspace\'s lead' };
      return { bot: lead };
    }
    if (parent) {
      if (parent.from.kind !== 'bot') return { refusal: 'no_addressee', detail: 'the handoff replied to was not sent by a bot' };
      const bot = safeGet(bots, parent.from.botId);
      if (!bot || !bot.enabled) return { refusal: 'no_addressee', detail: `bot ${parent.from.botId} is not enabled` };
      return { bot };
    }
    const lead = this.leadOf(bots, sender.workspaceId, sender.botId);
    if (!lead || lead.id === sender.botId) return { refusal: 'no_addressee', detail: 'a result without replyTo goes to the workspace lead, and there is none to send it to' };
    return { bot: lead };
  }

  /** A workspace's lead: its oldest enabled coordinator (the team's lead
   *  routes) other than the sender, else its oldest enabled bot stored with
   *  the `lead` role (a coordinator's own work goes there, as before). */
  private leadOf(bots: NonNullable<ReturnType<HandoffRouterOptions['ports']>['bots']>, workspaceId: string, senderId: string): BotProfile | null {
    let enabled: BotProfile[] = [];
    try {
      enabled = bots.listEnabled();
    } catch {
      return null;
    }
    const here = enabled.filter((b) => b.enabled && b.workspaceId === workspaceId).sort((a, b) => a.createdAt - b.createdAt);
    return here.find((b) => isCoordinatorBot(b) && b.id !== senderId) ?? here.find((b) => b.role === 'lead') ?? null;
  }

  /** The hop a running wake hands the bot (addressed to it), or null: the
   *  handoff the wake delivers, or — for the answer to a question the bot
   *  asked while it held a hop — that hop. */
  private wokenHop(botId: string, handoffId: string | undefined): Handoff | null {
    const woken = handoffId ? this.records.get(handoffId) ?? null : null;
    if (!woken || woken.to.kind !== 'bot' || woken.to.botId !== botId) return null;
    if (woken.kind === 'answer' && woken.replyTo) {
      const ask = this.records.get(woken.replyTo);
      const hop = ask?.forHop ? this.records.get(ask.forHop) : undefined;
      if (hop && hop.to.kind === 'bot' && hop.to.botId === botId) return hop;
    }
    return woken;
  }

  /** Whether a delivered result / refusal already answers this handoff. */
  private answered(parentId: string): boolean {
    for (const h of this.records.values()) {
      if (h.replyTo === parentId && (h.kind === 'result' || h.kind === 'refusal') && h.status !== 'refused') return true;
    }
    return false;
  }

  private byClientId(botId: string, clientHandoffId: string | undefined): Handoff | null {
    if (!clientHandoffId) return null;
    for (const h of this.records.values()) {
      if (h.clientHandoffId === clientHandoffId && h.from.kind === 'bot' && h.from.botId === botId) return h;
    }
    return null;
  }

  /** What a send returned, rebuilt from the stored handoff (a duplicate). */
  private resultOf(h: Handoff, duplicate: boolean): HandoffResult {
    const dup = duplicate ? { duplicate: true as const } : {};
    if (h.status === 'refused') {
      return { ok: false, code: h.refusal?.code ?? 'no_addressee', message: h.refusal?.detail ?? 'refused', handoffId: h.id, ...dup };
    }
    const to = h.to.kind === 'bot' ? safeGet(this.opts.ports().bots, h.to.botId) : null;
    const decision = h.kind === 'ask_person' ? this.decisionOf(h) : null;
    return {
      ok: true,
      handoffId: h.id,
      status: h.status,
      threadId: h.threadId,
      ...(h.to.kind === 'bot' ? { to: { botId: h.to.botId, role: to?.role ?? 'unknown', workspaceId: h.to.workspaceId } } : {}),
      ...(decision ? { decisionId: decision.id } : {}),
      ...dup,
    };
  }

  /** The highest hop of a run that was not refused (0 for a new run). The
   *  stored hop numbers outlive pruning of older hops of the same run. */
  private hopsIn(runId: string): number {
    let n = 0;
    for (const h of this.records.values()) if (h.runId === runId && h.status !== 'refused') n = Math.max(n, h.hopsInRun);
    return n;
  }

  /** Store, announce and wake. A wake the queue does not take refuses the hop. */
  private deliver(draft: Handoff, bot: BotProfile): HandoffResult {
    const h: Handoff = { ...draft, status: 'queued' };
    if (this.records.get(h.id)?.status !== 'queued' && !this.put(h)) {
      return { ok: false, code: 'write_failed', message: 'the handoff could not be stored' };
    }
    const wakes = this.opts.ports().wakes;
    let wakeId: string | undefined;
    try {
      // Pinned to the handoff's thread: the addressee's posts, questions
      // and handoffs without a thread land there, not in `general`. An
      // answer is never turned away by a full queue.
      // A room mention wakes as one (keyed by its card); every other
      // handoff as a handoff.
      const cardId = h.kind === 'message' && h.from.kind === 'bot' && h.clientHandoffId === mentionKey(h.payload.refs?.messageId ?? '', bot.id)
        ? h.payload.refs?.messageId : undefined;
      const reason: WakeReason = cardId && h.from.kind === 'bot'
        ? { kind: 'mention', cardId, handoffId: h.id, fromBotId: h.from.botId }
        : { kind: 'handoff', handoffId: h.id };
      wakeId = wakes?.enqueue({
        botId: bot.id, workspaceId: bot.workspaceId, reason, priority: 1, threadId: h.threadId,
        ...(h.kind === 'answer' ? { overCap: true as const } : {}),
      })?.id;
    } catch (err) {
      this.log(`wake for handoff ${h.id} failed`, err);
    }
    if (!wakeId) return this.refuse(h, 'budget', `${this.partyLabel(h.to)} did not take the wake (disabled, over budget or queue full)`);
    // Wake first, then the status: a stop before the status line leaves the
    // handoff queued, and the next start redelivers it into the same wake.
    const mark = (): void => {
      if (this.records.get(h.id)?.status !== 'queued') return;
      const delivered: Handoff = { ...h, status: 'delivered' };
      if (this.put(delivered)) this.emit('handoff.received', delivered);
    };
    if (wakes?.flush) {
      const p = wakes.flush().then(mark, (err: unknown) => this.log(`wake for handoff ${h.id} not on disk; it stays queued`, err));
      this.settling.add(p);
      void p.finally(() => this.settling.delete(p));
    } else {
      mark();
    }
    return {
      ok: true,
      handoffId: h.id,
      // The addressee took the wake; the stored status follows once it is on disk.
      status: 'delivered',
      threadId: h.threadId,
      to: { botId: bot.id, role: bot.role, workspaceId: bot.workspaceId },
      wakeId,
    };
  }

  private refuse(draft: Handoff, code: HandoffRefusalCode, detail: string): HandoffResult {
    const h: Handoff = { ...draft, status: 'refused', refusal: { code, detail: oneLine(detail, 500) } };
    const stored = this.put(h);
    this.emit('handoff.refused', h);
    return { ok: false, code, message: detail, ...(stored ? { handoffId: h.id } : {}) };
  }

  /** The handoff fact; when the fact log is missing or drops it, the room
   *  card is written directly so no hop goes unseen. */
  private emit(kind: 'handoff.received' | 'handoff.refused', h: Handoff): void {
    // Directed: the addressee for a delivery; for a refusal, the bot that
    // sent it (it is the one that must react).
    const directed = kind === 'handoff.received'
      ? (h.to.kind === 'bot' ? h.to.botId : undefined)
      : (h.from.kind === 'bot' ? h.from.botId : h.to.kind === 'bot' ? h.to.botId : undefined);
    const fromWs = partyWorkspace(h.from);
    const toWs = partyWorkspace(h.to);
    // A delivery belongs to the addressee's workspace, a refusal to the sender's.
    const workspaceId = kind === 'handoff.received' ? toWs : fromWs ?? toWs;
    const draft: FactDraft = {
      kind,
      at: this.now(),
      ...(workspaceId ? { workspaceId } : {}),
      ref: { handoffId: h.id, ...(directed ? { botId: directed } : {}) },
      actor: h.from.kind === 'bot' ? { kind: 'bot', id: h.from.botId } : { kind: h.from.kind === 'human' ? 'human' : 'system' },
      payload: {
        handoffKind: h.kind,
        title: h.payload.title,
        threadId: h.threadId,
        runId: h.runId,
        depth: h.depth,
        hopsInRun: h.hopsInRun,
        fromLabel: this.partyLabel(h.from),
        toLabel: this.partyLabel(h.to),
        ...(fromWs ? { fromWorkspaceId: fromWs } : {}),
        ...(toWs ? { toWorkspaceId: toWs } : {}),
        ...(h.refusal ? { code: h.refusal.code, detail: h.refusal.detail } : {}),
        ...(h.kind === 'answer' ? { answer: h.payload.body.slice(0, HANDOFF_STORE_LIMITS.ANSWER_MAX) } : {}),
        // A room card's mention: the card says it, so its delivery is no line.
        ...(h.clientHandoffId?.startsWith('mention:') ? { mention: true } : {}),
      },
    };
    const ports = this.opts.ports();
    let fact: Fact | null = null;
    try {
      fact = ports.factLog?.append(draft) ?? null;
    } catch (err) {
      this.log(`fact for handoff ${h.id} not written`, err);
    }
    if (fact) return;
    const rooms = this.opts.rooms();
    if (rooms) writeFactCards(rooms, { ...draft, id: `local-${kind}-${h.id}`, seq: 0, dedupeKey: '' }, ports.bots);
  }

  private partyLabel(p: Party): string {
    if (p.kind === 'human') return 'the owner';
    if (p.kind === 'system') return 'wmux';
    const bot = safeGet(this.opts.ports().bots, p.botId);
    return bot ? `${bot.name || bot.role} (${bot.role})` : p.botId;
  }

  // ── ask_person ──

  /** A bot asks the owner. The question is raised in its thread now, or
   *  waits there behind the thread's open decision. */
  askPerson(sender: BotBinding, params: AskPersonParams): Promise<HandoffResult> {
    const ports = this.opts.ports();
    // The default key is taken now, in call order, like a send's.
    const asking = runningWake(ports, sender.botId);
    const clientHandoffId = params?.clientHandoffId ?? wakeOrdinals.next(asking, 'handoff');
    return this.serial(async () => {
      const title = oneLine(params?.title, HANDOFF_STORE_LIMITS.TITLE_MAX);
      if (!title) return invalid('title is required');
      const namedThread = params.threadId === undefined ? undefined : parseThreadId(params.threadId);
      if (namedThread === null) return invalid('threadId is not a thread id');
      if (params.clientHandoffId !== undefined && !isClientId(params.clientHandoffId)) return invalid('clientHandoffId is not a valid key');
      const prior = this.byClientId(sender.botId, clientHandoffId);
      if (prior) return prior.kind === 'ask_person' ? this.resultOf(prior, true) : invalid('clientHandoffId was used for a handoff');
      const from = botParty(sender);
      const id = newId('h');
      const options = sanitizeOptions(params.options);
      // A question asked in a wake about one task is about that task (the
      // owner's view counts it once with the task's own needs-input).
      const named = sanitizeRefs(params.refs);
      const refs = asking?.taskId && !named?.taskId ? { ...(named ?? {}), taskId: asking.taskId } : named;
      // Asked while the bot holds a hop it has not answered: the answer's
      // wake answers that hop.
      const held = this.wokenHop(sender.botId, asking?.handoffId);
      const forHop = held && (held.kind === 'dispatch' || held.kind === 'message') && !this.answered(held.id) ? held.id : undefined;
      const h: Handoff = {
        version: 1,
        id,
        runId: newId('run'),
        threadId: namedThread ?? runningWakeThread(ports, sender.botId) ?? (`handoff:${id}` as ThreadId),
        depth: 0,
        hopsInRun: 1,
        from,
        to: { kind: 'human' },
        kind: 'ask_person',
        attribution: { originator: from, chain: [] },
        landing: 'room+phone',
        payload: {
          title,
          body: capBody(params.body, HANDOFF_STORE_LIMITS.BODY_MAX),
          ...(refs ? { refs: refs as FactRef } : {}),
          ...(options ? { options } : {}),
        },
        status: 'queued',
        ...(clientHandoffId ? { clientHandoffId } : {}),
        ...(asking?.reasonKind === 'intro' ? { intro: true as const } : {}),
        ...(asking?.ownerCardId ? { ownerCardId: asking.ownerCardId } : {}),
        ...(forHop ? { forHop } : {}),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      if (!surfaceAllows(sender, 'ask_person')) return this.refuse(h, 'surface', 'the bot surface has no ask_person');
      const replaced = [...this.records.values()].filter((old) => isOpenAsk(old) && old.from.kind === 'bot' && old.from.botId === sender.botId && old.threadId === h.threadId);
      const open = [...this.records.values()].filter((r) => isOpenAsk(r) && partyWorkspace(r.from) === sender.workspaceId).length;
      if (open - replaced.length >= HANDOFF_STORE_LIMITS.OPEN_ASKS_PER_WORKSPACE) {
        return this.refuse(h, 'budget', `the workspace already has ${open} open questions`);
      }
      if (!this.put(h)) return { ok: false, code: 'write_failed', message: 'the question could not be stored' };
      // A newer question of the same bot in the same thread replaces its open
      // one there (once the new one is stored): the thread frees for it, and
      // the old card closes.
      for (const old of replaced) await this.closeQuietly(old);
      const raised = await this.tryRaise(h);
      if (raised.decision) {
        return { ok: true, handoffId: h.id, status: this.records.get(h.id)?.status ?? 'queued', threadId: h.threadId, decisionId: raised.decision.id };
      }
      return {
        ok: true,
        handoffId: h.id,
        status: 'queued',
        threadId: h.threadId,
        ...(raised.busyWith ? { queuedBehind: raised.busyWith } : {}),
      };
    });
  }

  /** Raise a queued ask in its thread when the thread is free. */
  private async tryRaise(h: Handoff): Promise<{ decision?: WorkspaceDecision; busyWith?: string }> {
    const ws = partyWorkspace(h.from);
    if (!ws) return {};
    let busy = this.opts.decisions.inThread(ws, h.threadId);
    // Its own decision (raised before a stop cut the status write short).
    if (busy && busy.handoffId === h.id) return this.markRaised(h, ws, busy);
    // The decision of a question already closed (its clear failed): cleared
    // now, so the thread does not stay blocked behind it.
    const holder = busy?.origin === 'ask_person' && busy.handoffId ? this.records.get(busy.handoffId) : undefined;
    if (busy && holder && !isOpenAsk(holder)) {
      await this.opts.decisions.clear(ws, h.threadId, busy.id).catch(() => false);
      busy = this.opts.decisions.inThread(ws, h.threadId);
    }
    if (busy) return { busyWith: busy.id };
    let decision: WorkspaceDecision | null = null;
    try {
      decision = await this.opts.decisions.raise(ws, h.threadId, {
        question: h.payload.title,
        ...(h.payload.options ? { options: h.payload.options } : {}),
        context: h.payload.body,
        handoffId: h.id,
      });
    } catch (err) {
      this.log(`question ${h.id} not raised`, err);
    }
    // Not raised and not busy: the write failed; it stays queued and is
    // retried on the next decision change or start.
    if (!decision) return {};
    return this.markRaised(h, ws, decision);
  }

  /** The question is a decision now: mark it delivered and show its card. */
  private markRaised(h: Handoff, ws: string, decision: WorkspaceDecision): { decision: WorkspaceDecision } {
    // A lost status line is adopted again on the next reconcile.
    this.put({ ...h, status: 'delivered' });
    if (this.questionCardId(h)) return { decision };
    const options = h.payload.options?.length ? `\n\nOptions: ${h.payload.options.join(' / ')}` : '';
    const writer = this.opts.rooms();
    // Raised now or later (queued behind the thread's open decision), the
    // question answers the owner message the bot asked it about.
    const replyTo = writer ? wakeReplyTo(writer, h, ws, h.threadId) : undefined;
    writer?.append({
      workspaceId: ws,
      threadId: h.threadId,
      kind: 'question',
      actor: h.from,
      title: h.payload.title,
      body: `${h.payload.body}${options}`.slice(0, ROOM_LIMITS.CARD_BODY_MAX),
      refs: { ...(h.payload.refs ?? {}), handoffId: h.id, decisionId: decision.id },
      state: 'open',
      ...(h.intro ? { greeting: true as const } : {}),
    }, replyTo ? { replyTo } : undefined);
    return { decision };
  }

  // ── Closing questions nobody needs to answer any more ──

  /** Close an open question without an answer: its decision cleared, its
   *  card resolved, nothing sent to the bot, nobody woken. Inside serial. */
  private async closeQuietly(h: Handoff): Promise<boolean> {
    if (!isOpenAsk(h)) return false;
    // Answered already (reconcile has not taken the answer yet): the answer
    // goes to the bot instead.
    if (h.status === 'delivered' && (this.decisionOf(h)?.status ?? 'pending') !== 'pending') return false;
    const ws = partyWorkspace(h.from);
    // Closed first, so the decision's clear does not read as an unanswered
    // question (reconcile would then post "Question closed").
    if (!this.put({ ...h, status: 'expired' })) return false;
    this.closeQuestionCard(h);
    const d = h.status === 'delivered' ? this.decisionOf(h) : null;
    if (ws && d) await this.opts.decisions.clear(ws, h.threadId, d.id).catch(() => false);
    return true;
  }

  private async closeWhere(match: (h: Handoff) => boolean): Promise<string[]> {
    const closed: string[] = [];
    for (const h of [...this.records.values()]) {
      if (isOpenAsk(h) && match(h) && (await this.closeQuietly(h))) closed.push(h.id);
    }
    return closed;
  }

  /** A bot finished a turn on the owner's words: its questions asked before
   *  those words in the thread they were said in, and — when the words were
   *  for this bot alone (its 1:1), not the whole room — those in a thread of
   *  their own, were answered in chat. A question with options closes only
   *  when the words are one of its options (isSameAnswer) and it is the one
   *  such question: that option is stored as its answer, already delivered
   *  (the bot read the words in the turn that just ended, so no second wake),
   *  and the card reads answered. Other words ("Hi"), or words that match
   *  several questions ("Yes"), leave them open; the bot that judges a
   *  question answered closes it itself (question_close). Returns the
   *  handoff ids closed or answered. */
  closeAnsweredInChat(botId: string, item: Pick<WakeItem, 'reason' | 'threadId' | 'workspaceId' | 'enqueuedAt'>): Promise<string[]> {
    const r = item.reason;
    if (r.kind !== 'human') return Promise.resolve([]);
    const said = item.threadId ?? 'general';
    // Words to the whole room (every bot, or its coordinator for it) are
    // not a 1:1 answer.
    const toMe = r.room !== true && r.lead !== true;
    const text = typeof r.text === 'string' ? r.text : '';
    const asked = (h: Handoff) => h.from.kind === 'bot' && h.from.botId === botId
      && partyWorkspace(h.from) === item.workspaceId
      && h.createdAt < item.enqueuedAt
      && (h.threadId === said || (toMe && h.threadId === `handoff:${h.id}`));
    return this.serial(async () => {
      const answered: string[] = [];
      const picks: { h: Handoff; option: string }[] = [];
      for (const h of [...this.records.values()]) {
        const options = h.payload.options ?? [];
        if (!isOpenAsk(h) || options.length === 0 || !asked(h) || h.status !== 'delivered') continue;
        const option = options.find((o) => isSameAnswer(text, o));
        const d = this.decisionOf(h);
        if (option && d && (d.status ?? 'pending') === 'pending') picks.push({ h, option });
      }
      if (picks.length === 1 && (await this.answerFromChat(picks[0].h, picks[0].option))) answered.push(picks[0].h.id);
      const closed = await this.closeWhere((h) => asked(h) && !h.payload.options?.length);
      return [...answered, ...closed];
    });
  }

  /** A task stopped waiting for input (its worker went on, reported or
   *  ended): the questions its bot asked about it (refs.taskId) are moot. */
  closeTaskQuestions(taskId: string): Promise<string[]> {
    return this.serial(() => this.closeWhere((h) => h.payload.refs?.taskId === taskId));
  }

  /** The bot has a job now: its greeting question is moot. */
  closeIntroQuestions(botId: string): Promise<string[]> {
    return this.serial(() => this.closeWhere((h) => h.intro === true && h.from.kind === 'bot' && h.from.botId === botId));
  }

  /** A thread's subject ended (a PR merged or closed, an issue closed, a
   *  task done): its open questions are moot. */
  closeThreadQuestions(workspaceId: string, threadId: ThreadId): Promise<string[]> {
    return this.serial(() => this.closeWhere((h) => h.threadId === threadId && partyWorkspace(h.from) === workspaceId));
  }

  /** `question_close`: a bot closes one of its own open question cards. */
  closeOwnQuestion(bot: BotBinding, cardId: unknown): Promise<{ ok: true; handoffId: string } | { ok: false; code: 'invalid' | 'not_found'; message: string }> {
    return this.serial(async () => {
      if (typeof cardId !== 'string' || !cardId || cardId.length > 64) return { ok: false as const, code: 'invalid' as const, message: 'cardId is required' };
      const card = this.opts.rooms()?.get(bot.workspaceId, cardId) ?? null;
      const h = card?.kind === 'question' && card.refs?.handoffId ? this.records.get(card.refs.handoffId) : undefined;
      if (!card || !h || !isOpenAsk(h) || h.from.kind !== 'bot' || h.from.botId !== bot.botId || partyWorkspace(h.from) !== bot.workspaceId) {
        return { ok: false as const, code: 'not_found' as const, message: 'no open question of yours has this card id' };
      }
      if (!(await this.closeQuietly(h))) return { ok: false as const, code: 'not_found' as const, message: 'the question could not be closed' };
      return { ok: true as const, handoffId: h.id };
    });
  }

  /** Operator: answer an ask_person handoff (the same as answering its card). */
  answer(handoffId: string, answer: string): Promise<HandoffResult> {
    return this.serial(async () => {
      const text = typeof answer === 'string' ? answer.trim() : '';
      if (!text) return invalid('answer is required');
      const h = this.records.get(handoffId);
      if (!h || h.kind !== 'ask_person') return { ok: false, code: 'not_found', message: `no question ${handoffId}` };
      if (h.status === 'queued') {
        // Not raised yet: answered before its turn in the thread.
        if (!this.finalizeAnswer(h, text, false)) return { ok: false, code: 'write_failed', message: 'the answer could not be stored' };
      } else if (h.status === 'delivered') {
        const ws = partyWorkspace(h.from) as string;
        const d = this.decisionOf(h);
        if (!d) return { ok: false, code: 'not_pending', message: `question ${handoffId} has no open decision` };
        if (d.status === 'pending' && !(await this.opts.decisions.resolve(ws, d.id, text))) {
          return { ok: false, code: 'not_pending', message: `question ${handoffId} was answered already` };
        }
        await this.reconcileBody();
        // Resolved but not closed: the answer could not be stored yet (the
        // next reconcile tries again).
        if (this.records.get(handoffId)?.status === 'delivered' && this.decisionOf(h)?.status === 'resolved') {
          return { ok: false, code: 'write_failed', message: 'the answer could not be stored' };
        }
      } else {
        return { ok: false, code: 'not_pending', message: `question ${handoffId} is ${h.status}` };
      }
      const after = this.records.get(handoffId) as Handoff;
      const reply = [...this.records.values()].find((r) => r.kind === 'answer' && r.replyTo === handoffId);
      return {
        ok: true,
        handoffId,
        status: after.status,
        threadId: after.threadId,
        ...(reply ? { answerHandoffId: reply.id } : {}),
      };
    });
  }

  private decisionOf(h: Handoff): WorkspaceDecision | null {
    const ws = partyWorkspace(h.from);
    if (!ws) return null;
    return this.opts.decisions.forWorkspace(ws).find((d) => d.handoffId === h.id) ?? null;
  }

  /** Settle every open question against the decision store. Serialized. */
  reconcile(): Promise<void> {
    return this.serial(() => this.reconcileBody());
  }

  private async reconcileBody(): Promise<void> {
    const now = this.now();
    const asks = [...this.records.values()].filter(isOpenAsk).sort((a, b) => a.createdAt - b.createdAt);
    for (const h of asks.filter((a) => a.status === 'delivered')) {
      const ws = partyWorkspace(h.from) as string;
      const d = this.decisionOf(h);
      if (d && d.status === 'resolved') {
        if (this.finalizeAnswer(h, d.resolution ?? '', d.dismissed === true)) {
          await this.opts.decisions.clear(ws, h.threadId, d.id).catch(() => false);
        }
      } else if (!d) {
        this.expire(h, 'the question was closed without an answer');
      } else if (now - h.createdAt > HANDOFF_LIMITS.ASK_PERSON_TTL_MS) {
        await this.opts.decisions.clear(ws, h.threadId, d.id).catch(() => false);
        this.expire(h, 'no answer within the question\'s time limit');
      }
    }
    for (const h of asks.filter((a) => a.status === 'queued')) {
      // Answered before its turn, but not closed (a stop or a failed write
      // between the two): it closes with that answer, never asked again.
      const stored = this.storedAnswer(h.id);
      if (stored) {
        this.finalizeAnswer(h, stored.payload.body, stored.payload.body === DISMISSED_ANSWER);
        continue;
      }
      if (now - h.createdAt > HANDOFF_LIMITS.ASK_PERSON_TTL_MS) {
        this.expire(h, 'it waited past the question\'s time limit without being asked');
        continue;
      }
      await this.tryRaise(h);
    }
    await this.sweepClosedAskDecisions();
  }

  /** Clear ask_person decisions whose question is closed (a clear that
   *  failed before), so no thread stays blocked behind one. */
  private async sweepClosedAskDecisions(): Promise<void> {
    const workspaces = new Set<string>();
    for (const h of this.records.values()) {
      const ws = h.kind === 'ask_person' ? partyWorkspace(h.from) : undefined;
      if (ws) workspaces.add(ws);
    }
    for (const ws of workspaces) {
      for (const d of this.opts.decisions.forWorkspace(ws)) {
        if (d.origin !== 'ask_person' || !d.handoffId) continue;
        const h = this.records.get(d.handoffId);
        if (h && isOpenAsk(h)) continue;
        await this.opts.decisions.clear(ws, d.threadId ?? 'general', d.id).catch(() => false);
      }
    }
  }

  private questionCardId(h: Handoff): string | null {
    const ws = partyWorkspace(h.from);
    const rooms = this.opts.rooms();
    if (!ws || !rooms) return null;
    return rooms.find(ws, (c) => c.kind === 'question' && c.refs?.handoffId === h.id)?.id ?? null;
  }

  private closeQuestionCard(h: Handoff): void {
    const ws = partyWorkspace(h.from);
    const id = this.questionCardId(h);
    if (ws && id) this.opts.rooms()?.setState(ws, id, 'resolved');
  }

  private expire(h: Handoff, why: string): void {
    if (!this.put({ ...h, status: 'expired' })) return;
    this.closeQuestionCard(h);
    const ws = partyWorkspace(h.from);
    if (ws) {
      this.opts.rooms()?.append({
        workspaceId: ws,
        threadId: h.threadId,
        kind: 'fact',
        actor: { kind: 'system' },
        title: `Question closed: ${h.payload.title}`,
        body: why,
        refs: { handoffId: h.id },
      });
    }
  }

  /** An answer that is none of the options the bot offered is the owner
   *  overriding the bot: a `human.correction` fact. Choosing any offered
   *  option is not (the options carry no recommendation), and a free-text
   *  question has nothing to override. */
  private noteOverride(ask: Handoff, text: string): void {
    const ws = partyWorkspace(ask.from);
    const options = ask.payload.options ?? [];
    if (ask.from.kind !== 'bot' || !ws || options.length === 0) return;
    if (options.some((o) => isSameAnswer(text, o))) return;
    emitHumanCorrection(this.opts.ports(), {
      workspaceId: ws,
      botId: ask.from.botId,
      messageId: this.questionCardId(ask) ?? ask.id,
      category: 'question-override',
      cardKind: 'question',
      threadId: ask.threadId,
      note: text,
    }, this.now());
  }

  /** The owner answered: store the answer to the bot that asked (an
   *  `answer` handoff), then close the question and deliver the answer like
   *  any other handoff. The answer is on disk before the question closes, so
   *  a closed question always has its answer to deliver (a restart delivers
   *  a queued one); a second call reuses the stored answer. */
  private finalizeAnswer(ask: Handoff, text: string, dismissed: boolean): boolean {
    const stored = this.storedAnswer(ask.id);
    const reply = stored ?? this.answerFor(ask, text, dismissed);
    // Not stored: the ask stays open and the next reconcile tries again.
    if (!stored && !this.put(reply)) return false;
    if (!this.put({ ...ask, status: 'answered' })) return false;
    this.closeQuestionCard(ask);
    if (!dismissed) this.noteOverride(ask, text);
    if (reply.status !== 'queued') return true;
    const bot = ask.from.kind === 'bot' ? safeGet(this.opts.ports().bots, ask.from.botId) : null;
    if (!bot || !bot.enabled) this.refuse(reply, 'no_addressee', 'the bot that asked is not enabled');
    else this.deliver(reply, bot);
    return true;
  }

  /** The owner picked an option in chat: its answer is stored as delivered
   *  (the bot already read the words), the question closes as answered and
   *  its decision is cleared — the question first, so the clear does not
   *  read as a question closed unanswered. */
  private async answerFromChat(ask: Handoff, option: string): Promise<boolean> {
    if (this.storedAnswer(ask.id)) return false;
    const ws = partyWorkspace(ask.from);
    const d = this.decisionOf(ask);
    if (!ws || !d) return false;
    if (!this.put({ ...this.answerFor(ask, option, false), status: 'delivered' })) return false;
    if (!this.put({ ...ask, status: 'answered' })) return false;
    this.closeQuestionCard(ask);
    await this.opts.decisions.clear(ws, ask.threadId, d.id).catch(() => false);
    return true;
  }

  /** The answer handoff stored for a question, if any. */
  private storedAnswer(askId: string): Handoff | undefined {
    return [...this.records.values()].find((r) => r.kind === 'answer' && r.replyTo === askId);
  }

  private answerFor(ask: Handoff, text: string, dismissed: boolean): Handoff {
    const id = newId('h');
    return {
      version: 1,
      id,
      runId: ask.runId,
      threadId: ask.threadId,
      // The owner's answer is not a bot hop: same depth, never capped.
      depth: ask.depth,
      hopsInRun: this.hopsIn(ask.runId) + 1,
      from: { kind: 'human' },
      to: ask.from,
      kind: 'answer',
      replyTo: ask.id,
      attribution: { originator: ask.attribution.originator, chain: [...ask.attribution.chain, ask.id].slice(-HANDOFF_STORE_LIMITS.CHAIN_MAX) },
      landing: 'wake',
      payload: {
        title: ask.payload.title,
        body: (dismissed ? DISMISSED_ANSWER : text).slice(0, HANDOFF_STORE_LIMITS.ANSWER_MAX),
        ...(ask.payload.refs ? { refs: ask.payload.refs } : {}),
      },
      status: 'queued',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }
}

function invalid(message: string): HandoffResult {
  return { ok: false, code: 'invalid', message };
}

/** The owner's answer is the given option (case and spacing aside). */
export function isSameAnswer(answer: string, option: string): boolean {
  const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(answer) === norm(option);
}

function partyWorkspace(p: Party): string | undefined {
  return p.kind === 'bot' ? p.workspaceId : undefined;
}

function safeGet(bots: { get(id: string): BotProfile | null } | undefined, id: string): BotProfile | null {
  try {
    return bots?.get(id) ?? null;
  } catch {
    return null;
  }
}

// ── The running router ─────────────────────────────────────────────────────

let current: HandoffRouter | null = null;

/** Set by the handoff module's start(). */
export function setHandoffRouter(router: HandoffRouter | null): void {
  current = router;
}

/** The router, or null before the factory started. */
export function getHandoffRouter(): HandoffRouter | null {
  return current;
}

/** BotRuntime's `resolveHandoff` port. */
export function summarizeHandoff(id: string): HandoffWakeSummary | null {
  return current?.summarize(id) ?? null;
}

// ── Migration: moa-handoffs.json → handoffs.jsonl ──────────────────────────

/** One legacy Moa hand-off (moaHandoff.ts HandoffRecord) as a depth-0
 *  dispatch, or null when the record is unreadable. The legacy target was a
 *  pane, not a bot: the record keeps its title, body (with the target
 *  workspace) and task id for history; it addresses no bot. */
export function handoffFromLegacy(raw: unknown, now: number): Handoff | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const id = `h-legacy-${r.id.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 80)}`;
  const title = oneLine(r.title, HANDOFF_STORE_LIMITS.TITLE_MAX) || 'Moa hand-off';
  const target = r.target as Record<string, unknown> | undefined;
  const targetWs = typeof target?.workspaceId === 'string' ? target.workspaceId : '';
  const body = capBody(
    `${typeof r.body === 'string' ? r.body : ''}${targetWs ? `\n\nTarget workspace: ${targetWs}` : ''}`,
    HANDOFF_STORE_LIMITS.BODY_MAX,
  );
  const createdAt = finiteNumber(r.createdAt) ? r.createdAt : now;
  const updatedAt = finiteNumber(r.at) ? r.at : createdAt;
  const status: HandoffStatus = r.state === 'delivered' ? (finiteNumber(r.endedAt) ? 'answered' : 'delivered') : 'expired';
  const taskId = typeof r.taskId === 'string' && r.taskId.length <= 200 ? r.taskId : undefined;
  return parseHandoff({
    version: 1,
    id,
    runId: `run-${id}`,
    threadId: `handoff:${id}`,
    depth: 0,
    hopsInRun: 1,
    from: { kind: 'system' },
    to: { kind: 'system' },
    kind: 'dispatch',
    attribution: { originator: { kind: 'system' }, chain: [] },
    landing: 'room',
    payload: { title, body, ...(taskId ? { refs: { taskId } } : {}) },
    status,
    createdAt,
    updatedAt,
  });
}

/** Append every legacy hand-off not yet in handoffs.jsonl. Idempotent. The
 *  legacy file is left in place: moaHandoff.ts still owns it until it is
 *  deleted. Returns how many were imported. */
export function importLegacyMoaHandoffs(ctx: { wmuxDir: string; factoryDir: string; now: number }): number {
  const legacy = path.join(ctx.wmuxDir, LEGACY_MOA_HANDOFFS_FILENAME);
  if (!fs.existsSync(legacy)) return 0;
  const raw = atomicReadJSONSync<unknown>(legacy);
  const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : undefined;
  if (!items || typeof items !== 'object') return 0;
  const target = path.join(ctx.factoryDir, HANDOFFS_FILENAME);
  const have = new Set<string>();
  try {
    for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id === 'string') have.add(id);
      } catch {
        /* a torn line is the router's to drop */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  const lines: string[] = [];
  for (const rec of Object.values(items as Record<string, unknown>)) {
    const h = handoffFromLegacy(rec, ctx.now);
    if (h && !have.has(h.id)) {
      have.add(h.id);
      lines.push(JSON.stringify(h));
    }
  }
  appendJsonLines(target, lines);
  return lines.length;
}
