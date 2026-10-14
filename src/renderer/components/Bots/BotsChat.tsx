// ─── One Bots conversation, as a chat ────────────────────────────────────
//
// A 1:1 conversation is a bot's own room cards and the owner's messages to
// it; a group is a workspace's whole room (botsModel.ts). Bots speak on
// the left in soft bubbles (their markdown rendered as the room renders card
// bodies), the owner on the right in the user bubble, with the delivery line
// (sent to / queued for) under a message sent from here. A question is the
// room's own question card, answered in place; a plan or a proposal takes
// the room's own answers (CardAnswers). A system card (a refusal, a gate, a task's end, an error) is
// a quiet centred line with its body folded under Show more. A bot's live
// worker — at work, or waiting on input — sits at the foot as a compact
// status bubble with Open; so does a worker waiting for an agent slot, and a
// done one whose stopped Claude can resume the same conversation, with
// Resume. Open (and a Resume that started) shows the worker's terminal in a
// panel beside the chat (BotsWorkerPanel), never switching the active
// workspace, and the header's "N working" line names the live workers, each
// a toggle for that panel. A room shows its bots' workers the same way,
// under each bot's face. A bot's `job_changed`
// card carries Undo (the previous job, written back through the bot port's
// update).
//
// The owner never reads an internal id: a thread chip names a task by its
// title (a request, plan or report by its kind word), a routine card shows
// its schedule, a refusal its plain sentences (roomFormat.ts). In a room a
// bot's greeting is a one-line "joined" notice with the way to its 1:1,
// where the greeting itself is answered.
//
// While the bots are paused the conversation is read-only: no answers and
// no composer, only the reason under it.
//
// A bubble from a thread other than General carries a chip with the thread's
// reference; the chip narrows the conversation to that thread (the header
// offers the way back) and the composer then posts into it.
//
// Sending: a 1:1 message is a room post in the bot's workspace that mentions
// that one bot (main wakes it alone). A group message goes to the whole room
// — main wakes every bot of the workspace — unless bots are picked: the chip
// row under the box, or a leading `@name`.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RoomCard as RoomCardData, ThreadId } from '../../../shared/room';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import { renderBrainMarkdown } from '../shared/BrainMarkdown';
import { roomsApi, type RoomsApi } from '../../hooks/useRoomSync';
import { useStore } from '../../stores';
import type { FactoryBotPort, FactoryBotRow } from '../Room/factoryPorts';
import { RoomCard, useIdLabels } from '../Room/RoomCard';
import { CardAnswers, useWorkspaceNames } from '../Room/CardAnswers';
import { ApprovePendingChip } from '../Room/ApprovalAnswers';
import { pendingForChip, useApprovals } from '../Room/approvalsStore';
import { PresenceDot, botPresence } from '../Room/BotChips';
import { MentionChips, deliveryLine, roomBots, roomPostParams, sentFrom, useMentionPicks, type SentTo } from '../Room/RoomComposer';
import { actorLabel, botKindLabel, cardTone, formatCardTime, isRefThread, kindLabel, ownerCardText, planTextWithNames, threadLabel, threadRef, type IdLabels } from '../Room/roomFormat';
import { BOT_JOB_MAX, botTemplate, normalizeBotJob } from '../../../shared/bot';
import { templateJob } from '../Settings/FactoryTab';
import BotAvatar from '../Room/BotAvatar';
import { RoomAvatar } from './BotsAvatar';
import { awaitsApproval, conversationCards, greetingCardIds, livePlanIds, roomEntries, taskBubbles, type BotWorker, type Conversation } from './botsModel';
import type { BotTaskView } from '../../../shared/botTask';
import { botCanDo } from './botsProfile';
import { stopBotSummary, type BotsStopPort } from './botsStop';
import { InlineConfirm } from './InlineConfirm';
import BotsWorkerPanel from './BotsWorkerPanel';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';
import { selectWorkerPanelHost } from '../../stores/slices/roomSlice';
import { routineScheduleText, routineStateText, useBotRoutines } from '../Schedules/BotRoutines';
import '../Chat/chatMono.css';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Bodies longer than this fold behind "Show more". */
const BODY_FOLD_CHARS = 480;
/** A system card's body folds to two lines when it is longer than this or
 *  has more than one line. */
const SYSTEM_FOLD_CHARS = 140;

/** The cards a conversation shows, narrowed to one thread when asked: its
 *  own cards and those that link it (an approval card posted where the bot
 *  talks with the owner links its PR's thread). Pure. */
export function chatCards(conversation: Conversation, roomCards: readonly RoomCardData[], thread: ThreadId | null): RoomCardData[] {
  // A 1:1 is handed every room's cards (botConversationCards); a group its own.
  const own = conversation.kind === 'bot' ? conversationCards(roomCards, conversation.row.bot.id) : [...roomCards];
  return thread ? own.filter((c) => c.threadId === thread || c.refs?.threadId === thread) : own;
}

/** The thread a card links besides its own (its subject's), or null. */
function linkedThread(card: RoomCardData): ThreadId | null {
  const linked = card.refs?.threadId;
  return linked && linked !== card.threadId && linked !== 'general' ? linked : null;
}

/** Why a 1:1 message cannot be sent right now, or null: the bot is off. The
 *  message mentions this bot, so it reaches this bot alone. Pure. */
export function oneToOneRefusal(row: FactoryBotRow, t: T): string | null {
  return row.bot.enabled ? null : t('botsPage.botOff', { name: row.bot.name });
}

/** The composer's placeholder: a Lead's empty 1:1 says what to ask it for
 *  (the first task after adding it), any other "Message <name>". Pure. */
export function composerHint(conversation: Conversation, shown: number, title: string, t: T): string {
  if (conversation.kind === 'bot' && conversation.row.bot.role === 'lead' && shown === 0) return t('botsPage.leadHint', { name: title });
  return t('botsPage.messageTo', { name: title });
}

function newClientPostId(): string {
  return `bots-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A task's title by its id, from the bots' task lists (null: unknown). */
type TaskTitleOf = (taskId: string) => string | null;

/** The thread chip under a bubble (General has none): a PR or issue
 *  reference, else the thread's name in words; its id only in the tooltip. */
function ThreadChip({ threadId, t, onPick, taskTitle }: { threadId: ThreadId; t: T; onPick: (id: ThreadId) => void; taskTitle?: TaskTitleOf }) {
  if (threadId === 'general') return null;
  const label = threadLabel(threadId, t, taskTitle);
  const ref = isRefThread(threadId);
  return (
    <button
      type="button"
      data-bots-thread-chip={threadId}
      onClick={() => onPick(threadId)}
      title={ref ? t('botsPage.showThread', { thread: label }) : `${t('botsPage.showThread', { thread: label })} · ${threadRef(threadId, t)}`}
      className={`h-[20px] max-w-full truncate px-1.5 rounded-[var(--chip-radius)] bg-[var(--selection)] ${ref ? 'font-mono' : ''} text-[11px] text-[var(--text-sub)] hover:bg-[var(--selection-hover)] ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}

/** Undo on a bot's `job_changed` card: the job it replaced, written back
 *  as the owner (bot.update). */
function JobChangeUndo({ card, t, jobPort }: { card: RoomCardData; t: T; jobPort: Pick<FactoryBotPort, 'update'> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = card.jobChange;
  const update = jobPort.update;
  if (!change || !update) return null;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await update(change.botId, { job: change.previous });
      if (!r.ok) setError(r.message || t('room.jobChanged.undoFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-job-change-undo className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="secondary" data-testid="bots-job-undo" disabled={busy} onClick={() => void undo()}>{t('room.jobChanged.undo')}</Button>
      {error && <p role="alert" className="basis-full text-[11px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

function BotBubble({ card, sender, t, onThread, now, answers, api, nameOf, jobPort, readOnly, botNames = [], taskTitle, idLabels }: {
  card: RoomCardData;
  /** Every bot's name (owner text drops a role tag after one). */
  botNames?: readonly string[];
  taskTitle?: TaskTitleOf;
  /** What the ids a bot cites stand for (its text shows those instead). */
  idLabels?: IdLabels;
  /** The sender's name, shown in a group on the first of a run. */
  sender: string | null;
  t: T;
  onThread: (id: ThreadId) => void;
  now?: number;
  /** The card waits on the owner's Approve / Decline (and it may be given). */
  answers?: boolean;
  api?: RoomsApi | null;
  /** Workspace names, for a plan's text. */
  nameOf: (id: string) => string | null;
  /** A `job_changed` card's Undo (absent: none). */
  jobPort?: Pick<FactoryBotPort, 'update'>;
  /** The bots are paused (an approval shows its state only). */
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  // The answers can leave mid-edit (the plan was answered elsewhere, a newer
  // one superseded it, the bots were paused): the body comes back with them.
  useEffect(() => { if (!answers) setEditing(false); }, [answers]);
  const isPlan = card.kind === 'plan';
  const shown = ownerCardText(card, botNames, idLabels);
  const title = isPlan ? planTextWithNames(shown.title, nameOf, t) : shown.title;
  const body = (isPlan ? planTextWithNames(shown.body, nameOf, t) : shown.body).trim();
  const foldable = body.length > BODY_FOLD_CHARS;
  const tone = cardTone(card);
  const linked = linkedThread(card);
  return (
    <div
      className={`wmux-bots-bubble wmux-bots-bubble-bot ${answers && card.state === 'open' ? 'wmux-bots-bubble-waits' : ''}`}
      data-bots-bubble="bot"
      data-card-kind={card.kind}
      data-room-card-id={card.id}
      data-waits-on-owner={answers && card.state === 'open' ? 'true' : undefined}
    >
      {sender && <div className="mb-0.5 truncate text-[11px] text-[var(--text-sub)]">{sender}</div>}
      {card.kind !== 'opinion' && card.kind !== 'status' && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <span className={card.kind === 'refusal' ? 'text-[var(--accent-red)]' : card.kind === 'budget' ? 'text-[var(--accent-yellow)]' : undefined}>{kindLabel(card.kind, t)}</span>
          {tone && tone.word !== 'done' && (
            <span data-card-verdict={tone.word} className={tone.tone === 'danger' ? 'text-[var(--accent-red)]' : undefined}>{t(`room.verdict.${tone.word}`)}</span>
          )}
        </div>
      )}
      <div className="text-[14px] leading-snug text-[var(--text-main)] break-words">{title}</div>
      {answers && <CardAnswers card={card} workspaceId={card.workspaceId} t={t} api={api === undefined ? roomsApi() : api} onEditingChange={setEditing} readOnly={readOnly} />}
      {body && !editing && (
        <div data-card-body className={`mt-1 text-[14px] leading-relaxed text-[var(--text-sub)] break-words ${foldable && !expanded ? 'line-clamp-6' : ''}`}>
          {renderBrainMarkdown(body, { links: true })}
        </div>
      )}
      {foldable && !editing && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
          {expanded ? t('room.showLess') : t('room.showMore')}
        </button>
      )}
      {card.kind === 'job_changed' && jobPort && <JobChangeUndo card={card} t={t} jobPort={jobPort} />}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <ThreadChip threadId={card.threadId} t={t} onPick={onThread} taskTitle={taskTitle} />
        {linked && <ThreadChip threadId={linked} t={t} onPick={onThread} taskTitle={taskTitle} />}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{formatCardTime(card.at, now)}</span>
      </div>
    </div>
  );
}

/** A system card: the evidence itself (a refusal's reasons, a gate's
 *  result, a task's end, an error), as a centred line with its body folded
 *  to two lines under Show more (by height: a markdown list does not
 *  line-clamp). */
function SystemLine({ card, t, onThread, now, botNames = [], taskTitle }: { card: RoomCardData; t: T; onThread: (id: ThreadId) => void; now?: number; botNames?: readonly string[]; taskTitle?: TaskTitleOf }) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = ownerCardText(card, botNames);
  const foldable = body.length > SYSTEM_FOLD_CHARS || body.includes('\n');
  const word = card.kind === 'refusal' || card.kind === 'budget' ? kindLabel(card.kind, t) : null;
  return (
    <div className="wmux-bots-row wmux-bots-row-system" data-room-card-id={card.id} data-bots-bubble="system" data-card-kind={card.kind}>
      <div className="wmux-bots-system">
        <div className="flex min-w-0 items-baseline justify-center gap-1">
          {word && <span className={card.kind === 'refusal' ? 'shrink-0 text-[var(--accent-red)]' : 'shrink-0 text-[var(--accent-yellow)]'}>{word}</span>}
          <span className="min-w-0 break-words text-[var(--text-sub)]">{title}</span>
          <span className="shrink-0 tabular-nums">· {formatCardTime(card.at, now)}</span>
        </div>
        {body && (
          <div data-card-body data-clamped={foldable && !expanded ? 'true' : undefined} className={`mt-0.5 text-left text-[12px] leading-relaxed text-[var(--text-sub)] break-words ${foldable && !expanded ? 'max-h-[39px] overflow-hidden' : ''}`}>
            {renderBrainMarkdown(body, { links: true })}
          </div>
        )}
        {(foldable || card.threadId !== 'general') && (
          <div className="mt-0.5 flex items-center justify-center gap-2">
            {foldable && (
              <button type="button" data-card-more aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>
                {expanded ? t('room.showLess') : t('room.showMore')}
              </button>
            )}
            <ThreadChip threadId={card.threadId} t={t} onPick={onThread} taskTitle={taskTitle} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A bot added to the room: one quiet line, with the way to its 1:1 (where
 *  its greeting waits). */
function JoinedLine({ row, t, onOpen }: { row: FactoryBotRow; t: T; onOpen?: (botId: string) => void }) {
  return (
    <div className="wmux-bots-row wmux-bots-row-system" data-bots-joined={row.bot.id}>
      <div className="wmux-bots-system flex items-baseline justify-center gap-1.5">
        <span className="min-w-0 break-words text-[var(--text-sub)]">{t('botsPage.joined', { name: row.bot.name })}</span>
        {onOpen && (
          <button
            type="button"
            data-bots-joined-open={row.bot.id}
            onClick={() => onOpen(row.bot.id)}
            className={`shrink-0 text-[11px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-main)] hover:underline ${FOCUS_RING}`}
          >
            {t('botsPage.openChat')}
          </button>
        )}
      </div>
    </div>
  );
}

function workerState(worker: BotWorker): string {
  if (worker.needsInput) return 'botsPage.worker.needsInput';
  return worker.waiting ? 'botsPage.worker.waiting' : 'botsPage.worker.running';
}

function WorkerBubble({ worker, t, shown, onOpen }: { worker: BotWorker; t: T; shown: boolean; onOpen: (workspaceId: string) => void }) {
  return (
    <div
      className="wmux-bots-bubble wmux-bots-bubble-bot flex items-center gap-2"
      data-bots-worker={worker.workspaceId}
      data-worker-waiting={worker.waiting ? 'true' : undefined}
      data-worker-needs-input={worker.needsInput ? 'true' : undefined}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-[8px] w-[8px] shrink-0 rounded-full ${worker.waiting ? 'border-[1.5px] border-[var(--attention)]' : 'bg-[var(--text-muted)]'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-[var(--text-main)]">{worker.name}</span>
        <span className={`block text-[11px] ${worker.waiting ? 'text-[var(--attention-text)]' : 'text-[var(--text-muted)]'}`}>
          {t(workerState(worker))}
        </span>
        {worker.needsInput && worker.summary && (
          <span data-bots-worker-summary title={worker.summary} className="block truncate text-[12px] text-[var(--text-sub)]">{worker.summary}</span>
        )}
      </span>
      <Button
        size="sm"
        variant="secondary"
        data-bots-worker-open={worker.workspaceId}
        aria-label={t('botsPage.worker.openName', { name: worker.name })}
        aria-pressed={shown}
        onClick={() => onOpen(worker.workspaceId)}
      >
        {t('botsPage.worker.open')}
      </Button>
    </div>
  );
}

/** The most worker names the header line spells out; the rest are "+N". */
const WORKING_NAMES_MAX = 3;

/** The header's "N working" line: the live workers by name, each a toggle
 *  for the worker panel (pressed while it shows), a waiting one marked by
 *  the attention ring as on its bubble. */
function WorkingLine({ workers, shownId, onToggle, t }: { workers: readonly BotWorker[]; shownId: string | null; onToggle: (workspaceId: string) => void; t: T }) {
  const named = workers.slice(0, WORKING_NAMES_MAX);
  const more = workers.length - named.length;
  return (
    <div data-bots-working={workers.length} role="group" aria-label={t('botsPage.chat.working', { count: workers.length })} className="wmux-bots-working">
      <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{t('botsPage.chat.working', { count: workers.length })}</span>
      {named.map((w) => (
        <button
          key={w.workspaceId}
          type="button"
          data-bots-working-worker={w.workspaceId}
          aria-pressed={shownId === w.workspaceId}
          aria-label={t('botsPage.worker.openName', { name: w.name })}
          title={w.name}
          onClick={() => onToggle(w.workspaceId)}
          className={`wmux-bots-working-chip ${FOCUS_RING}`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${w.waiting ? 'border-[1.5px] border-[var(--attention)]' : 'bg-[var(--text-muted)]'}`}
          />
          <span className="min-w-0 truncate">{w.name}</span>
        </button>
      ))}
      {more > 0 && <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{`+${more}`}</span>}
    </div>
  );
}

/** What the worker panel's header says for the shown workspace: a live
 *  worker's name and state (needs-you text while it waits), else a task's
 *  title (a done worker), else its workspace's name with no state. */
function workerPanelView(workspaceId: string, workers: readonly BotWorker[], tasks: readonly BotTaskView[], t: T): { name: string; state: string | null; attention: boolean } {
  const live = workers.find((w) => w.workspaceId === workspaceId);
  if (live) return { name: live.name, state: t(workerState(live)), attention: live.waiting };
  const task = tasks.find((x) => (x.workerWorkspaceId ?? x.taskWorkspaceId) === workspaceId);
  if (task) return { name: task.title, state: t(task.stage === 'waiting_slot' ? 'botsPage.worker.waitingSlot' : 'botsPage.worker.resumable'), attention: false };
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  return { name: displayWorkspaceName(ws?.name ?? '', true), state: null, attention: false };
}

/** A bot's task that is not a live worker: waiting for an agent slot, or
 *  done with a stopped worker that can resume the same conversation. Open
 *  shows only while the worker's pane is still open; a cleared task offers
 *  Resume, which opens a new pane. */
function TaskBubble({ task, t, resumePort, readOnly, shownId, onOpen }: { task: BotTaskView; t: T; resumePort?: Pick<FactoryBotPort, 'resumeWorker'>; readOnly: boolean; shownId: string | null; onOpen: (workspaceId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeWorker = resumePort?.resumeWorker;
  // A Resume answered after this bubble left (another conversation) opens
  // nothing; one still shown opens in the conversation shown now.
  const live = useRef({ mounted: true, onOpen });
  live.current.onOpen = onOpen;
  useEffect(() => {
    live.current.mounted = true;
    return () => { live.current.mounted = false; };
  }, []);
  const waiting = task.stage === 'waiting_slot';
  const paneWorkspaceId = task.workerWorkspaceId ?? task.taskWorkspaceId;
  const paneOpen = useStore((s) => !!paneWorkspaceId && s.workspaces.some((w) => w.id === paneWorkspaceId));
  return (
    <div className="wmux-bots-bubble wmux-bots-bubble-bot flex items-center gap-2" data-bots-task={task.taskId} data-task-state={waiting ? 'waiting_slot' : 'resumable'}>
      <span aria-hidden="true" className="inline-block h-[8px] w-[8px] shrink-0 rounded-full border-[1.5px] border-[var(--text-muted)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-[var(--text-main)]">{task.title}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">{error ?? t(waiting ? 'botsPage.worker.waitingSlot' : 'botsPage.worker.resumable')}</span>
      </span>
      {!waiting && paneOpen && (
        <Button
          size="sm"
          variant="secondary"
          data-bots-worker-open={paneWorkspaceId}
          aria-label={t('botsPage.worker.openName', { name: task.title })}
          aria-pressed={!!paneWorkspaceId && shownId === paneWorkspaceId}
          onClick={() => { if (paneWorkspaceId) onOpen(paneWorkspaceId); }}
        >
          {t('botsPage.worker.open')}
        </Button>
      )}
      {!waiting && !readOnly && resumeWorker && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-bots-task-resume={task.taskId}
          aria-label={t('botsPage.worker.resumeName', { name: task.title })}
          onClick={() => {
            setBusy(true);
            setError(null);
            void resumeWorker(task.taskId)
              .then((r) => {
                if (!live.current.mounted) return;
                if (!r.ok) setError(r.message ?? null);
                else {
                  const opened = r.workspaceId ?? paneWorkspaceId;
                  if (opened) live.current.onOpen(opened);
                }
              })
              .catch((err: unknown) => { if (live.current.mounted) setError(String(err)); })
              .finally(() => { if (live.current.mounted) setBusy(false); });
          }}
        >
          {t('botsPage.worker.resume')}
        </Button>
      )}
    </div>
  );
}

function BotsComposer({ conversation, threadId, bots, placeholder, t, api, onSent, readOnly, cards = [] }: {
  conversation: Conversation;
  threadId: ThreadId;
  /** The cards the conversation shows (the approve chip counts theirs). */
  cards?: readonly RoomCardData[];
  bots: readonly FactoryBotRow[];
  placeholder: string;
  t: T;
  api?: RoomsApi | null;
  onSent: (cardId: string, sent: SentTo[] | null) => void;
  /** The bots are paused: nothing is sent. */
  readOnly?: boolean;
}) {
  const [text, setText] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedPost = useRef<{ key: string; clientPostId: string } | null>(null);
  const textNow = useRef(text);
  const workspaceId = conversation.workspaceId;
  // The pending approval requests whose cards this conversation shows now,
  // whatever thread a card sits in (a 1:1: this bot's, in any room; a view
  // narrowed to a thread shows that thread's cards and those linking it).
  const { list: approvals } = useApprovals();
  const scopeBot = conversation.kind === 'bot' ? conversation.row.bot.id : undefined;
  const pendingIds = useMemo(() => (readOnly ? [] : pendingForChip(approvals, cards, scopeBot ? { botId: scopeBot } : { workspaceId })
    .map((r) => r.requestId)), [approvals, cards, readOnly, scopeBot, workspaceId]);
  const picks = useMentionPicks(bots, workspaceId);
  const mentions: string[] = conversation.kind === 'bot' ? [conversation.row.bot.id] : picks.picked;
  const refusal = readOnly ? t('botsPage.pausedComposer') : conversation.kind === 'bot' ? oneToOneRefusal(conversation.row, t) : null;

  const submit = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (inFlight || refusal) return;
    const bridge = api === undefined ? roomsApi() : api;
    const submitted = text;
    const key = JSON.stringify([workspaceId, threadId, text, mentions]);
    const clientPostId = failedPost.current?.key === key ? failedPost.current.clientPostId : newClientPostId();
    const params = roomPostParams({ workspaceId, threadId, text, mentions, clientPostId });
    if (!params) return;
    if (!bridge) {
      setError(t('room.composer.unavailable'));
      return;
    }
    setInFlight(true);
    setError(null);
    try {
      const r = await bridge.post(params);
      failedPost.current = r.ok ? null : { key, clientPostId };
      if (r.ok) {
        if (textNow.current === submitted) {
          textNow.current = '';
          setText('');
          picks.reset();
        }
        onSent(r.card.id, sentFrom(r));
      } else {
        setError(r.message || t('room.composer.failed'));
      }
    } catch (err) {
      failedPost.current = { key, clientPostId };
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(false);
    }
  }, [api, inFlight, refusal, text, workspaceId, threadId, mentions, picks, t, onSent]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
    }
  };
  const line = error ?? refusal;
  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="bots-composer"
      data-channel-composer
      data-in-flight={inFlight ? 'true' : 'false'}
      className="wmux-channel-composer wmux-chat-composer"
    >
      <ApprovePendingChip ids={pendingIds} t={t} />
      <div className="relative flex items-end gap-2">
        <textarea
          rows={1}
          value={text}
          data-testid="bots-composer-input"
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(e) => {
            textNow.current = e.target.value;
            setText(e.target.value);
            if (conversation.kind === 'room') picks.onText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          className="wmux-chat-input wmux-channel-input text-[14px]"
        />
        <button
          type="submit"
          data-testid="bots-composer-send"
          disabled={!text.trim() || inFlight || !!refusal}
          aria-label={t('room.composer.send')}
          title={t('room.composer.send')}
          className="wmux-chat-send wmux-chat-icon-button wmux-channel-send"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="7" y1="11" x2="7" y2="3" />
            <polyline points="3.5,6.5 7,3 10.5,6.5" />
          </svg>
        </button>
      </div>
      {conversation.kind === 'room' && !refusal && (
        <MentionChips candidates={roomBots(bots, workspaceId)} bots={bots} picked={picks.picked} onToggle={picks.toggle} t={t} testId="bots-composer" />
      )}
      {line && (
        <p role={error ? 'alert' : 'status'} data-testid="bots-composer-status" className={`text-[11px] ${error ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'}`}>
          {line}
        </p>
      )}
    </form>
  );
}

function ProfileLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]">
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 truncate text-[var(--text-main)]">{value}</span>
    </div>
  );
}

/** Stop: the bot's turn and its workers, after an inline confirm. The
 *  result is a toast. */
function StopBot({ row, port, t }: { row: FactoryBotRow; port: BotsStopPort; t: T }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const stopBot = port.stopBot;
  if (!stopBot) return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await stopBot(row.bot.id);
      useStore.getState().pushToast({ message: stopBotSummary(row.bot.name, r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) setConfirming(false);
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 border-t border-[var(--stroke)] pt-2" data-bots-stop-bot={row.bot.id}>
      {confirming ? (
        <InlineConfirm
          text={t('botsPage.stop.botConfirm', { name: row.bot.name })}
          confirmLabel={t('botsPage.stop.bot')}
          cancelLabel={t('room.hq.cancel')}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
          testId="bots-stop-bot"
        />
      ) : (
        <Button size="sm" variant="destructive" data-testid="bots-stop-bot" onClick={() => setConfirming(true)}>{t('botsPage.stop.bot')}</Button>
      )}
    </div>
  );
}

/** The bot's job in its profile: the text, and Edit when the bot port can
 *  update (saved as the owner; an empty job clears it). */
function JobLine({ row, t, jobPort }: { row: FactoryBotRow; t: T; jobPort?: Pick<FactoryBotPort, 'update'> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.bot.job ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = jobPort?.update;
  const ok = draft.trim() === '' || normalizeBotJob(draft) !== undefined;
  const save = async () => {
    if (!update) return;
    setBusy(true);
    setError(null);
    try {
      const r = await update(row.bot.id, { job: draft.trim() === '' ? null : draft.trim() });
      if (r.ok) setEditing(false);
      else setError(r.message || t('botsPage.profile.jobFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // No job of its own: it works on its template's starting job, shown in
  // the owner's language (main's copy of it is English).
  const startingJob = row.bot.job ? '' : templateJob(botTemplate(row.bot), t);
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-job>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.job')}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <textarea
              data-testid="bots-profile-job-input"
              aria-label={t('botsPage.profile.job')}
              value={draft}
              rows={4}
              maxLength={BOT_JOB_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className={`w-full rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-main)] outline-none ${FOCUS_RING}`}
            />
            <div className="mt-1 flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(row.bot.job ?? ''); setError(null); }}>{t('settings.factory.cancel')}</Button>
              <Button size="sm" variant="primary" data-testid="bots-profile-job-save" disabled={busy || !ok} onClick={() => void save()}>{t('settings.factory.save')}</Button>
            </div>
            {error && <p role="alert" className="mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
          </>
        ) : (
          <>
            <p data-bots-profile-job-text className={`whitespace-pre-wrap break-words ${row.bot.job ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>
              {row.bot.job ?? (startingJob || t('botsPage.profile.noJob'))}
            </p>
            {startingJob && <p data-bots-profile-job-default className="text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.defaultJob')}</p>}
            {update && (
              <button
                type="button"
                data-testid="bots-profile-job-edit"
                onClick={() => { setDraft(row.bot.job ?? ''); setEditing(true); }}
                className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
              >
                {t('botsPage.profile.editJob')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The bot's profile under its name pill: template, job (editable),
 *  workspace, repo, on/off, turns used and left today, its routines
 *  (read-only), then what it can do (the shared powers,
 *  read-only), whom it reports to, its workers now, and Stop. */
function BotProfile({ row, workers, workspaceName, t, stopPort, jobPort }: { row: FactoryBotRow; workers: readonly BotWorker[]; workspaceName: string; t: T; stopPort: BotsStopPort; jobPort?: Pick<FactoryBotPort, 'update'> }) {
  const left = row.status?.budgetLeft?.turnsDay;
  const routines = (useBotRoutines()?.routines ?? []).filter((r) => r.botId === row.bot.id);
  const canDo = botCanDo(row.bot);
  const waiting = workers.filter((w) => w.waiting).length;
  const running = workers.length - waiting;
  return (
    <div data-bots-profile={row.bot.id} className="px-3 py-2">
      <ProfileLine label={t('botsPage.profile.template')} value={<span data-bots-profile-template>{botKindLabel(row.bot, t)}</span>} />
      <JobLine key={`${row.bot.id}:${row.bot.job ?? ''}`} row={row} t={t} jobPort={jobPort} />
      <ProfileLine label={t('botsPage.profile.workspace')} value={workspaceName} />
      <ProfileLine label={t('botsPage.profile.repo')} value={row.bot.repo?.repoKey ?? t('botsPage.profile.noRepo')} />
      <ProfileLine label={t('botsPage.profile.state')} value={`${t(row.bot.enabled ? 'botsPage.profile.on' : 'botsPage.profile.off')} · ${t(`room.presence.${botPresence(row)}`)}`} />
      {typeof left === 'number' && (
        <ProfileLine
          label={t('botsPage.profile.turnsToday')}
          value={<span data-bots-profile-turns>{t('botsPage.profile.turnsTodayValue', { used: Math.max(0, row.bot.budget.maxTurnsPerDay - left), left })}</span>}
        />
      )}
      {routines.length > 0 && (
        <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-routines>
          <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.routines')}</span>
          <ul className="min-w-0 flex-1 space-y-0.5">
            {routines.map((r) => (
              <li key={r.id} data-bot-routine={r.id} className={`truncate ${r.state === 'paused' ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}>
                {`${r.title} · ${routineScheduleText(r.schedule)} · ${routineStateText(r)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-1 border-t border-[var(--stroke)] pt-1">
        <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-can-do>
          <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.canDo')}</span>
          <ul className="min-w-0 flex-1 space-y-0.5 text-[var(--text-main)]">
            {canDo.map((key) => <li key={key} data-can-do={key}>{t(key)}</li>)}
          </ul>
        </div>
        <ProfileLine label={t('botsPage.profile.reportsTo')} value={<span data-bots-profile-reports-to>{t('botsPage.profile.reportsToYou')}</span>} />
        <ProfileLine
          label={t('botsPage.profile.workersNow')}
          value={(
            <span data-bots-profile-workers={workers.length}>
              {t('botsPage.profile.workersRunning', { count: running })}
              {waiting > 0 && <span className="text-[var(--attention-text)]">{` · ${t('botsPage.profile.workersWaiting', { count: waiting })}`}</span>}
            </span>
          )}
        />
      </div>
      <StopBot row={row} port={stopPort} t={t} />
    </div>
  );
}

export function BotsChat({ conversation, roomCards, bots, title, workspaceName, t, onBack, api, now, readOnly = false, stopPort = {}, jobPort, resumePort, onOpenBot }: {
  conversation: Conversation;
  roomCards: readonly RoomCardData[];
  /** Every bot (names for senders and the addressee check). */
  bots: readonly FactoryBotRow[];
  title: string;
  workspaceName: string;
  t: T;
  onBack: () => void;
  api?: RoomsApi | null;
  now?: number;
  /** The bots are paused: no answers, nothing sent. */
  readOnly?: boolean;
  /** The stop verbs (botsStop.ts); absent ones show no control. */
  stopPort?: BotsStopPort;
  /** The bot port's update: the profile's job editor and a job_changed
   *  card's Undo (absent: neither). */
  jobPort?: Pick<FactoryBotPort, 'update'>;
  /** The bot port's resumeWorker: a done worker's Resume (absent: none). */
  resumePort?: Pick<FactoryBotPort, 'resumeWorker'>;
  /** Opens a bot's 1:1 (a room's "joined" line; absent: no link). */
  onOpenBot?: (botId: string) => void;
}): React.ReactElement {
  const [thread, setThread] = useState<ThreadId | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, SentTo[] | null>>({});
  const actors = useStore((s) => s.roomActors);
  const cards = useMemo(() => chatCards(conversation, roomCards, thread), [conversation, roomCards, thread]);
  // The plans still waiting (each bot's newest), judged on every card the
  // conversation holds, not just the shown thread.
  const livePlans = useMemo(() => livePlanIds(roomCards), [roomCards]);
  const nameOf = useWorkspaceNames();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // A 1:1 spans rooms, whose seqs are separate: the newest card's id says
  // something new arrived.
  const lastId = cards[cards.length - 1]?.id ?? '';
  const workers = conversation.workers;
  const group = conversation.kind === 'room';
  // A room lists its bots' tasks the same way, each under its bot.
  const taskRows = conversation.kind === 'bot' ? [conversation.row] : conversation.bots;
  const tasks = taskRows.flatMap((r) => taskBubbles(r.tasks, now ?? Date.now()));
  // In a room a bot's greeting is its "joined" line (its 1:1 keeps it).
  // Judged on the whole room; a view narrowed to one thread shows it as it is.
  const entries = useMemo(() => {
    if (conversation.kind !== 'room' || thread) return cards.map((card) => ({ kind: 'card' as const, card }));
    const greetings = greetingCardIds(roomCards, conversation.bots);
    const greeted = new Set<string>();
    for (const c of roomCards) if (greetings.has(c.id) && c.actor.kind === 'bot') greeted.add(c.actor.botId);
    return roomEntries(cards.filter((c) => !greetings.has(c.id)), conversation.bots, greeted);
  }, [cards, roomCards, conversation, thread]);
  const botNames = useMemo(() => bots.map((b) => b.bot.name), [bots]);
  const taskTitle = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of bots) for (const task of r.tasks ?? []) byId.set(task.taskId, task.title);
    return (id: string) => byId.get(id) ?? null;
  }, [bots]);
  const idLabels = useIdLabels(bots, t);
  const faceOf = (botId: string) => bots.find((b) => b.bot.id === botId)?.bot ?? null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastId, thread, workers.length]);
  const onSent = useCallback((cardId: string, to: SentTo[] | null) => {
    atBottom.current = true;
    setSent((cur) => ({ ...cur, [cardId]: to }));
  }, []);
  const pickThread = (id: ThreadId) => {
    atBottom.current = true;
    setThread(id);
  };
  // The profile closes on Escape or a press outside it (the pill toggles it).
  const profileRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!profileRef.current?.contains(target) && !pillRef.current?.contains(target)) setProfileOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setProfileOpen(false);
      pillRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [profileOpen]);
  const presence = conversation.kind === 'bot' ? botPresence(conversation.row) : null;
  // The worker panel belongs to the conversation it was opened from: another
  // conversation closes it.
  const panel = useStore((s) => s.botsWorkerPanel);
  const shownId = panel && panel.conversationId === conversation.id ? panel.workspaceId : null;
  const hostedId = useStore(selectWorkerPanelHost);
  useEffect(() => {
    const st = useStore.getState();
    if (st.botsWorkerPanel && st.botsWorkerPanel.conversationId !== conversation.id) st.setBotsWorkerPanel(null);
  }, [conversation.id]);
  const openWorker = useCallback((workspaceId: string) => {
    useStore.getState().setBotsWorkerPanel({ workspaceId, conversationId: conversation.id });
  }, [conversation.id]);
  const toggleWorker = (workspaceId: string) => {
    if (shownId === workspaceId) useStore.getState().setBotsWorkerPanel(null);
    else openWorker(workspaceId);
  };
  const shown = shownId ? workerPanelView(shownId, workers, tasks, t) : null;

  return (
    <div className="wmux-bots-chat-area" data-worker-open={shownId ? 'true' : undefined}>
    <section className="wmux-bots-chat" data-bots-chat={conversation.id} aria-label={title}>
      <div className="wmux-bots-chat-head">
        <button type="button" data-bots-back onClick={onBack} aria-label={t('botsPage.back')} title={t('botsPage.back')} className={`wmux-bots-back ${FOCUS_RING}`}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9,2.5 4.5,7 9,11.5" /></svg>
        </button>
        <button
          type="button"
          ref={pillRef}
          data-bots-pill
          aria-expanded={conversation.kind === 'bot' ? profileOpen : undefined}
          onClick={() => setProfileOpen((v) => !v)}
          disabled={conversation.kind !== 'bot'}
          className={`wmux-bots-pill ${FOCUS_RING}`}
        >
          {conversation.kind === 'bot' ? <BotAvatar bot={conversation.row.bot} size={20} /> : <RoomAvatar bots={conversation.bots} size={20} />}
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{title}</span>
          {presence && <PresenceDot presence={presence} />}
          {group && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{conversation.bots.length === 1 ? t('botsPage.botCountOne') : t('botsPage.botCount', { count: conversation.bots.length })}</span>}
        </button>
        {!thread && workers.length > 0 && <WorkingLine workers={workers} shownId={shownId} onToggle={toggleWorker} t={t} />}
        {thread && (
          <button
            type="button"
            data-bots-thread-back
            onClick={() => { atBottom.current = true; setThread(null); }}
            className={`ml-auto h-[24px] shrink-0 inline-flex items-center gap-1 px-2 rounded-[6px] text-[12px] text-[var(--text-sub)] hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
          >
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><polyline points="9,2.5 4.5,7 9,11.5" /></svg>
            <span>{t('botsPage.allMessages')}</span>
            <span className={`${isRefThread(thread) ? 'font-mono ' : ''}max-w-[220px] truncate text-[11px] text-[var(--text-muted)]`}>{threadLabel(thread, t, taskTitle)}</span>
          </button>
        )}
      </div>
      {profileOpen && conversation.kind === 'bot' && (
        <div className="wmux-bots-profile" ref={profileRef}><BotProfile row={conversation.row} workers={workers} workspaceName={workspaceName} t={t} stopPort={stopPort} jobPort={readOnly ? undefined : jobPort} /></div>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label={title}
        data-bots-messages
        className="wmux-bots-messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {entries.length === 0 && workers.length === 0 && tasks.length === 0 && (
          <p data-bots-empty-chat className="py-8 text-center text-[12px] text-[var(--text-muted)]">{t('botsPage.noMessages')}</p>
        )}
        {entries.map((entry, i) => {
          if (entry.kind === 'joined') return <JoinedLine key={`joined:${entry.row.bot.id}`} row={entry.row} t={t} onOpen={onOpenBot} />;
          const card = entry.card;
          const before = entries[i - 1];
          const prev = before?.kind === 'card' ? before.card : undefined;
          const firstOfRun = !prev || prev.actor.kind !== card.actor.kind
            || (card.actor.kind === 'bot' && prev.actor.kind === 'bot' && prev.actor.botId !== card.actor.botId);
          if (card.actor.kind === 'human') {
            const line = card.id in sent ? deliveryLine(sent[card.id], bots, t) : null;
            const text = (card.body?.trim() ? card.body : card.title).trim();
            return (
              <div key={card.id} className="wmux-bots-row wmux-bots-row-owner" data-room-card-id={card.id} data-bots-bubble="owner">
                <div className="wmux-bots-bubble wmux-bots-bubble-owner">{text}</div>
                <div className="mt-0.5 flex items-center justify-end gap-1.5">
                  <ThreadChip threadId={card.threadId} t={t} onPick={pickThread} taskTitle={taskTitle} />
                  {line && <span data-bots-delivery className="text-[11px] text-[var(--text-muted)]">{line}</span>}
                </div>
              </div>
            );
          }
          if (card.actor.kind === 'system') {
            return <SystemLine key={card.id} card={card} t={t} onThread={pickThread} now={now} botNames={botNames} taskTitle={taskTitle} />;
          }
          const botId = card.actor.kind === 'bot' ? card.actor.botId : '';
          const botRow = bots.find((b) => b.bot.id === botId);
          const role = botRow?.bot.role ?? actors[botId]?.role;
          const showAvatar = group && firstOfRun;
          const sender = group && firstOfRun ? actorLabel(card.actor, t, bots, actors) : null;
          // A bot the runtime no longer lists still gets a face: its name as the room knows it.
          const face = botRow?.bot ?? (role ? { id: botId, name: actorLabel(card.actor, t, bots, actors), role } : null);
          // A question is the room's own card (answered in place); a paused
          // page shows it as a bubble with no answers.
          const question = card.kind === 'question' && !readOnly;
          // An approval card always shows its request's state (answers only
          // while the bots run).
          const answers = (!readOnly && awaitsApproval(card, livePlans)) || card.kind === 'approval';
          return (
            <div key={card.id} className="wmux-bots-row wmux-bots-row-bot">
              {group && <span className="wmux-bots-row-avatar">{showAvatar && face ? <BotAvatar bot={face} size={24} /> : null}</span>}
              {question ? (
                <div className={`wmux-bots-card ${card.kind === 'question' && card.state === 'open' ? '' : 'wmux-bots-bubble-bot'}`} data-bots-bubble="card">
                  <RoomCard card={card} workspaceId={card.workspaceId} t={t} bots={bots} roomsBridge={api} now={now} />
                  {card.threadId !== 'general' && <div className="px-3 pb-1.5"><ThreadChip threadId={card.threadId} t={t} onPick={pickThread} taskTitle={taskTitle} /></div>}
                </div>
              ) : (
                <BotBubble card={card} sender={sender} t={t} onThread={pickThread} now={now} answers={answers} api={api} nameOf={nameOf} readOnly={readOnly} botNames={botNames} taskTitle={taskTitle} idLabels={idLabels} {...(!readOnly && jobPort ? { jobPort } : {})} />
              )}
            </div>
          );
        })}
        {!thread && workers.map((w) => {
          const face = group ? faceOf(w.botId) : null;
          return (
            <div key={w.workspaceId} className="wmux-bots-row wmux-bots-row-bot">
              {group && <span className="wmux-bots-row-avatar">{face ? <BotAvatar bot={face} size={24} /> : null}</span>}
              <WorkerBubble worker={w} t={t} shown={shownId === w.workspaceId} onOpen={openWorker} />
            </div>
          );
        })}
        {!thread && tasks.map((task) => {
          const face = group ? faceOf(task.botId) : null;
          return (
            <div key={task.taskId} className="wmux-bots-row wmux-bots-row-bot">
              {group && <span className="wmux-bots-row-avatar">{face ? <BotAvatar bot={face} size={24} /> : null}</span>}
              <TaskBubble task={task} t={t} resumePort={resumePort} readOnly={readOnly} shownId={shownId} onOpen={openWorker} />
            </div>
          );
        })}
      </div>

      <div className="wmux-bots-composer">
        <BotsComposer
          conversation={conversation}
          threadId={thread ?? 'general'}
          bots={bots}
          placeholder={composerHint(conversation, cards.length, title, t)}
          t={t}
          api={api}
          onSent={onSent}
          readOnly={readOnly}
          cards={cards}
        />
      </div>
    </section>
    {shownId && shown && (
      <BotsWorkerPanel
        workspaceId={shownId}
        hosted={hostedId === shownId}
        name={shown.name}
        state={shown.state}
        attention={shown.attention}
        t={t}
        onClose={() => useStore.getState().setBotsWorkerPanel(null)}
      />
    )}
    </div>
  );
}
