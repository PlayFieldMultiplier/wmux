// The first-run wizard's last step: the bot's first task (contract in
// shared/firstRun.ts, "The bot's first task"). A folder the bot will read,
// one consent on the wizard's own screen, then a bot made once for that
// folder gets one read-only task in its 1:1 and the wizard shows its first
// answer. Nothing is turned on, created or posted before the consent.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FIRST_TASK_CLIENT_POST_ID,
  FIRST_TASK_EXAMPLES,
  type FirstBotRequest,
  type FirstBotResult,
  type FirstRunFolderCheck,
  type FirstTaskExample,
} from '../../shared/firstRun';
import { GENERAL_THREAD, dmThreadId, parseThreadId, type RoomCard, type ThreadId } from '../../shared/room';
import type { FactoryBotRepoSuggestion } from '../../shared/botCreate';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import { CATCH_UP_MAX_PAGES, roomsApi, type RoomsApi } from '../hooks/useRoomSync';
import { getFactoryBotPort, getFactorySettingsPort } from './Room/factoryPorts';
import { roomPostParams } from './Room/RoomComposer';
import { turnBotsOn } from './Bots/botsAddBot';
import { pickFolderDialog } from './Settings/FactoryTab';
import { selectBotConversationOnOpen } from './Bots/botsSelection';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import Button from './ui/Button';
import { IconCheck, IconWarning } from './icons';
import { FOCUS_RING } from './focusRing';

type T = (key: string, vars?: Record<string, string | number>) => string;

interface FirstTaskBridge {
  checkFolder: (folder: string) => Promise<FirstRunFolderCheck>;
  firstBot: (req: FirstBotRequest) => Promise<FirstBotResult>;
  complete: () => Promise<void>;
}

function firstTaskBridge(): Partial<FirstTaskBridge> {
  const api = (window as unknown as { electronAPI?: { firstRun?: Partial<FirstTaskBridge> } }).electronAPI;
  return api?.firstRun ?? {};
}

/** The waits of the flow (the not_started retry and the answer poll). */
export interface FirstTaskTiming {
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const REAL_TIMING: FirstTaskTiming = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
let timing = REAL_TIMING;

/** Tests: replace the clock and the waits (null restores the real ones). */
export function setFirstTaskTimingForTests(next: FirstTaskTiming | null): void {
  timing = next ?? REAL_TIMING;
}

/** A bot made right after the bots were turned on may meet a runtime still
 *  starting: asked again a few times, briefly (as createBot does). */
const NOT_STARTED_RETRIES = 3;
const NOT_STARTED_WAIT_MS = 400;
/** The answer is polled this often; after STILL_WAITING_MS the row says the
 *  bot is still working, and after GIVE_UP_MS the wizard stops waiting and
 *  points to the chat, where the answer lands whenever it comes. */
export const ANSWER_POLL_MS = 1_000;
export const STILL_WAITING_MS = 45_000;
export const GIVE_UP_MS = 10 * 60_000;
/** Until the owner picks a folder or the suggested one checks ok, the
 *  suggestion is asked again this often: the workspace's folder may change
 *  under the open wizard (a `cd` in its pane). */
export const SUGGEST_POLL_MS = 1_500;
/** The answer's body is shown up to this many characters. */
const ANSWER_EXCERPT_MAX = 600;

export type FolderStatus = 'none' | 'checking' | 'ok' | 'not_a_repo' | 'no_remote';

export interface FirstTaskFolder {
  path: string;
  status: FolderStatus;
  displayRoot?: string;
}

/**
 * idle → consent (the usage screen) → starting (bots on, the bot made, the
 * task posted) → waiting (the answer polled) → answered | late | error.
 */
export type FirstTaskPhase = 'idle' | 'consent' | 'starting' | 'waiting' | 'answered' | 'late' | 'error';

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/** The task the bot is sent for an example, in the owner's language. Both
 *  only read. */
export function firstTaskText(example: FirstTaskExample, t: T): string {
  return t(`firstRunWizard.firstTask.example.${example}.task`);
}

/** The folder check's answer as the row's status. */
export function folderStatusOf(check: FirstRunFolderCheck): FolderStatus {
  if (check.ok) return 'ok';
  return check.code === 'no_remote' ? 'no_remote' : 'not_a_repo';
}

/** A refused suggestion as the row's status: a folder that is no repository
 *  a bot can read says so; no folder at all is `none`. */
export function suggestionStatusOf(code: Extract<FactoryBotRepoSuggestion, { ok: false }>['code']): FolderStatus {
  if (code === 'no_remote') return 'no_remote';
  return code === 'not_a_repo' || code === 'repo_untrusted' ? 'not_a_repo' : 'none';
}

export type FirstTaskOutcome = { kind: 'answer' | 'error'; card: RoomCard };

/** The notice codes of a General card that say a bot's turn did not run. */
const TURN_FAILED_NOTICES: ReadonlySet<string> = new Set(['bot.error', 'bot.usageLimit', 'budget.exhausted', 'budget.held']);

/**
 * A card wmux wrote in General about this bot after the task card
 * (`taskSeq`; seq is the room's, so it orders across threads) that says its
 * turn did not run: an error, the usage limit, a budget stop, a refusal.
 */
export function firstTaskFailure(generalCards: readonly RoomCard[], botId: string, taskSeq: number): RoomCard | null {
  return generalCards
    .filter((c) => c.seq > taskSeq && c.actor.kind === 'system' && c.refs?.botId === botId)
    .sort((a, b) => a.seq - b.seq)
    .find((c) => c.kind === 'refusal' || c.kind === 'budget' || (c.notice !== undefined && TURN_FAILED_NOTICES.has(c.notice.code))) ?? null;
}

/**
 * The bot's first card after the task card (`taskSeq`): its answer, or an
 * error when it is a refusal or a budget stop (the bot's own, or the one
 * wmux writes for it). Earlier cards and the task card itself never count.
 */
export function firstTaskOutcome(cards: readonly RoomCard[], botId: string, taskSeq: number): FirstTaskOutcome | null {
  const after = cards.filter((c) => c.seq > taskSeq).sort((a, b) => a.seq - b.seq);
  for (const card of after) {
    const failed = card.kind === 'refusal' || card.kind === 'budget';
    if (card.actor.kind === 'bot' && card.actor.botId === botId) return { kind: failed ? 'error' : 'answer', card };
    if (failed && card.actor.kind === 'system') return { kind: 'error', card };
  }
  return null;
}

/** Which footer action the step offers the wizard's primary rule. */
export type FirstTaskPrimary = 'send' | 'open' | 'busy' | 'none';

export function firstTaskPrimary(phase: FirstTaskPhase, canSend: boolean): FirstTaskPrimary {
  if (phase === 'consent' || phase === 'starting' || phase === 'waiting') return 'busy';
  if (phase === 'answered' || phase === 'late') return 'open';
  return phase === 'idle' && canSend ? 'send' : 'none';
}

function excerpt(text: string | undefined): string {
  const s = (text ?? '').trim();
  return s.length > ANSWER_EXCERPT_MAX ? `${s.slice(0, ANSWER_EXCERPT_MAX - 1)}…` : s;
}

// ─── The flow ─────────────────────────────────────────────────────────────────

async function firstBotWithRetry(make: FirstTaskBridge['firstBot'], req: FirstBotRequest): Promise<FirstBotResult> {
  let r = await make(req);
  for (let i = 0; i < NOT_STARTED_RETRIES && !r.ok && r.code === 'not_started'; i += 1) {
    await timing.wait(NOT_STARTED_WAIT_MS);
    r = await make(req);
  }
  return r;
}

/** A thread's cards after `sinceSeq`, oldest first, every page; null when
 *  the room could not be read. */
async function readThread(api: RoomsApi, workspaceId: string, threadId: ThreadId, sinceSeq: number): Promise<{ cards: RoomCard[]; next: number } | null> {
  const cards: RoomCard[] = [];
  let next = sinceSeq;
  for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
    const r = await api.read({ workspaceId, threadId, sinceSeq: next });
    if (!r.ok) return page > 0 ? { cards, next } : null;
    cards.push(...r.cards);
    next = Math.max(next, r.nextSinceSeq);
    if (!r.hasMore || r.cards.length === 0) break;
  }
  return { cards, next };
}

export interface FirstTaskState {
  folder: FirstTaskFolder | null;
  example: FirstTaskExample;
  phase: FirstTaskPhase;
  /** Waiting past STILL_WAITING_MS. */
  still: boolean;
  /** The answer, the error card, or the refusal's message. */
  outcome: { card?: RoomCard; message?: string } | null;
  canSend: boolean;
  /** The text Send will post: the selected example's, in the owner's language. */
  taskText: string;
  /** The first-run bot, once made. */
  botId: string | null;
  /** The first-run bot was made earlier for the folder now shown. */
  existingBot: boolean;
  choose: () => void;
  selectExample: (example: FirstTaskExample) => void;
  send: () => void;
  cancel: () => void;
  confirm: () => void;
}

export function useFirstTask({ enabled, workspaceId }: { enabled: boolean; workspaceId: string | null }): FirstTaskState {
  const t = useT();
  const [folder, setFolder] = useState<FirstTaskFolder | null>(null);
  // A folder the owner picked is theirs: the suggestion no longer replaces it.
  const [picked, setPicked] = useState(false);
  // The same, read by a suggestion already on its way when the pick lands.
  const pickedRef = useRef(false);
  const [example, setExample] = useState<FirstTaskExample>(FIRST_TASK_EXAMPLES[0]);
  const [phase, setPhase] = useState<FirstTaskPhase>('idle');
  const [still, setStill] = useState(false);
  const [outcome, setOutcome] = useState<FirstTaskState['outcome']>(null);
  const [botId, setBotId] = useState<string | null>(null);
  // The first-run bot made earlier reads another folder than the row showed.
  const [existingBot, setExistingBot] = useState(false);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // Only the newest check lands: a pick made while the suggestion was being
  // checked wins.
  const checkSeq = useRef(0);
  // `quiet`: the suggestion's re-check of the folder already shown keeps its
  // status until the answer, instead of flashing "Checking…" every poll.
  const check = useCallback(async (path: string, quiet = false) => {
    const bridge = firstTaskBridge();
    if (!bridge.checkFolder) return;
    const seq = ++checkSeq.current;
    if (!quiet) setFolder({ path, status: 'checking' });
    let r: FirstRunFolderCheck;
    try {
      r = await bridge.checkFolder(path);
    } catch (err) {
      r = { ok: false, code: 'invalid_argument', message: err instanceof Error ? err.message : String(err) };
    }
    if (!live.current || seq !== checkSeq.current) return;
    setFolder(r.ok ? { path: r.root, status: 'ok', displayRoot: r.displayRoot } : { path, status: folderStatusOf(r) });
  }, []);

  // The default: the folder "Add bot" would suggest for the active
  // workspace, asked when the step appears and again every SUGGEST_POLL_MS
  // until the owner picks a folder or the suggested one checks ok.
  const settled = folder?.status === 'ok';
  const shown = useRef<string | null>(null);
  shown.current = folder?.path ?? null;
  useEffect(() => {
    if (!enabled || !workspaceId || picked || settled) return;
    const suggest = getFactoryBotPort().suggestRepo;
    if (!suggest) return;
    let on = true;
    void (async () => {
      while (on) {
        const s = await suggest(workspaceId).catch(() => null);
        if (!on || pickedRef.current) return;
        if (s?.ok) {
          await check(s.root, s.root === shown.current);
        } else if (s) {
          ++checkSeq.current;
          setFolder({ path: '', status: suggestionStatusOf(s.code) });
        }
        if (!on) return;
        await timing.wait(SUGGEST_POLL_MS);
      }
    })();
    return () => { on = false; };
  }, [enabled, workspaceId, picked, settled, check]);

  const choose = useCallback(() => {
    void pickFolderDialog().then((path) => {
      if (!path || !live.current) return;
      pickedRef.current = true;
      setPicked(true);
      void check(path);
    }, () => undefined);
  }, [check]);

  const canSend = enabled && !!workspaceId && folder?.status === 'ok' && phase === 'idle';

  const selectExample = useCallback((next: FirstTaskExample) => {
    if (phase === 'idle') setExample(next);
  }, [phase]);
  const send = useCallback(() => {
    if (canSend) setPhase('consent');
  }, [canSend]);
  const cancel = useCallback(() => {
    setPhase((p) => (p === 'consent' ? 'idle' : p));
  }, []);

  // One run per wizard: a second click on Confirm before the re-render
  // starts nothing.
  const running = useRef(false);
  const confirm = useCallback(async () => {
    const bridge = firstTaskBridge();
    if (running.current || phase !== 'consent' || !workspaceId || folder?.status !== 'ok' || !bridge.firstBot) return;
    running.current = true;
    const text = firstTaskText(example, t);
    setPhase('starting');
    setStill(false);
    const fail = (message?: string, card?: RoomCard) => {
      if (!live.current) return;
      setOutcome({ message, card });
      setPhase('error');
    };
    try {
      // The consent was given on this screen.
      const on = await turnBotsOn(getFactorySettingsPort(), () => Promise.resolve(true));
      if (on !== 'on') return fail();
      const made = await firstBotWithRetry(bridge.firstBot, { workspaceId, folder: folder.path });
      if (!made.ok) return fail(made.message);
      const api = roomsApi();
      if (!api) return fail();
      const botId = made.bot.id;
      setBotId(botId);
      // A bot that reads another folder (one made earlier, when a first run
      // was left before its task, or one made now on a clone of the same
      // repository the workspace's bot already reads): show that folder and
      // send nothing, so the task never names a folder the bot does not read.
      if (made.bot.repoPath && made.bot.repoPath !== folder.path) {
        if (!live.current) return;
        const shown = await bridge.checkFolder?.(made.bot.repoPath).catch(() => null);
        if (!live.current) return;
        pickedRef.current = true;
        setPicked(true);
        setFolder({ path: made.bot.repoPath, status: 'ok', displayRoot: shown?.ok ? shown.displayRoot : made.bot.repoPath });
        setExistingBot(true);
        running.current = false;
        setPhase('idle');
        return;
      }
      const roomId = made.bot.workspaceId;
      const threadId = parseThreadId(made.threadId) ?? dmThreadId(botId);

      // Posted once: a task already in the bot's 1:1 (the first run
      // re-run after a quit) is waited on, not sent again.
      const before = await readThread(api, roomId, threadId, 0);
      if (!before) return fail();
      // The wizard closed meanwhile: nothing is sent after the owner left.
      if (!live.current) return;
      let taskSeq = before.cards.find((c) => c.kind === 'human')?.seq;
      if (taskSeq === undefined) {
        const params = roomPostParams({ workspaceId: roomId, threadId, text, mentions: [botId], clientPostId: FIRST_TASK_CLIENT_POST_ID });
        if (!params) return fail();
        const posted = await api.post(params);
        if (!posted.ok) return fail(posted.message);
        taskSeq = posted.card.seq;
      }
      if (!live.current) return;
      setPhase('waiting');

      const started = timing.now();
      let since = taskSeq;
      let sinceGeneral = taskSeq;
      for (;;) {
        const page = await readThread(api, roomId, threadId, since).catch(() => null);
        // A turn that did not run is said in General, not in the 1:1.
        const general = await readThread(api, roomId, GENERAL_THREAD, sinceGeneral).catch(() => null);
        if (!live.current) return;
        const failed = general ? firstTaskFailure(general.cards, botId, taskSeq) : null;
        if (failed) return fail(failed.title, failed);
        if (general) sinceGeneral = Math.max(sinceGeneral, general.next);
        const found = page ? firstTaskOutcome(page.cards, botId, taskSeq) : null;
        if (found?.kind === 'error') return fail(found.card.title, found.card);
        if (found) {
          setOutcome({ card: found.card });
          setPhase('answered');
          void firstTaskBridge().complete?.().catch(() => undefined);
          return;
        }
        if (page) since = Math.max(since, page.next);
        const waited = timing.now() - started;
        if (waited >= GIVE_UP_MS) {
          setPhase('late');
          void firstTaskBridge().complete?.().catch(() => undefined);
          return;
        }
        if (waited >= STILL_WAITING_MS) setStill(true);
        await timing.wait(ANSWER_POLL_MS);
        if (!live.current) return;
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [phase, workspaceId, folder, example, t]);

  return {
    folder,
    example,
    phase,
    still,
    outcome,
    canSend,
    taskText: firstTaskText(example, t),
    botId,
    existingBot,
    choose,
    selectExample,
    send,
    cancel,
    confirm: () => void confirm(),
  };
}

/** Opens the Bots page on the first-run bot's 1:1. */
export function openFirstTaskConversation(botId: string | null): void {
  if (botId) selectBotConversationOnOpen(botId);
  useStore.getState().openBotsPage();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * The step in the wizard's body: a heading, then one grouped container with
 * the folder row, the two example rows and, once sent, the state row. The
 * usage screen is a nested alert dialog. Send / Open live in the footer
 * ({@link FirstTaskFooterAction}).
 */
export function FirstTaskBlock({ task }: { task: FirstTaskState }) {
  const t = useT();
  const { folder, phase } = task;
  const locked = phase !== 'idle';
  const folderStatus: FolderStatus = folder?.status ?? 'none';
  const folderIcon = folderStatus === 'ok' ? 'ok' : folderStatus === 'not_a_repo' || folderStatus === 'no_remote' ? 'warn' : 'todo';
  return (
    <section className="flex flex-col gap-2" data-testid="first-run-first-task">
      <div>
        <h3 className="ui-row-title">{t('firstRunWizard.firstTask.heading')}</h3>
        <p className="ui-row-detail">{t('firstRunWizard.firstTask.hint')}</p>
      </div>
      <div className="ui-group">
        <div className="ui-row" data-testid="first-run-folder-row">
          <RowIcon status={folderIcon} />
          <div className="ui-row-text">
            <p className="ui-row-title">{t('firstRunWizard.firstTask.folder')}</p>
            <p className="ui-row-detail" data-testid="first-run-folder-status" data-status={folderStatus}>
              {folderStatus === 'ok' && <code className="ui-code">{folder?.displayRoot ?? folder?.path}</code>}
              {folderStatus === 'checking' && t('firstRunWizard.firstTask.folderChecking')}
              {folderStatus === 'none' && t('firstRunWizard.firstTask.folderNone')}
              {(folderStatus === 'not_a_repo' || folderStatus === 'no_remote') && t('firstRunWizard.firstTask.folderNotRepo')}
            </p>
            {task.existingBot && <p className="ui-row-detail" data-testid="first-run-folder-existing-bot">{t('firstRunWizard.firstTask.existingBot')}</p>}
          </div>
          <div className="ui-row-action">
            <Button size="sm" variant="ghost" onClick={task.choose} disabled={locked || task.existingBot} data-testid="first-run-folder-choose">
              {t('firstRunWizard.firstTask.choose')}
            </Button>
          </div>
        </div>

        <div role="radiogroup" aria-label={t('firstRunWizard.firstTask.heading')} className="contents">
          {FIRST_TASK_EXAMPLES.map((ex) => {
            const on = ex === task.example;
            return (
              <button
                key={ex}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={locked}
                onClick={() => task.selectExample(ex)}
                data-testid={`first-run-first-task-example-${ex}`}
                className={`ui-row w-full text-left disabled:cursor-default ${FOCUS_RING} ${on ? 'bg-[var(--selection)]' : 'enabled:hover:bg-[var(--hover-fill)]'}`}
              >
                <span className="ui-row-icon" aria-hidden="true">
                  {on ? <IconCheck size={14} /> : <span className="wmux-welcome-todo" />}
                </span>
                <span className="ui-row-text">
                  <span className="ui-row-title">{t(`firstRunWizard.firstTask.example.${ex}.title`)}</span>
                  <span className="ui-row-detail">{t(`firstRunWizard.firstTask.example.${ex}.detail`)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <FirstTaskStateRow task={task} />
      </div>

      {phase === 'consent' && <FirstTaskConsent onConfirm={task.confirm} onCancel={task.cancel} />}
    </section>
  );
}

function RowIcon({ status }: { status: 'ok' | 'todo' | 'warn' | 'error' | 'running' }) {
  return (
    <span className="ui-row-icon" aria-hidden="true">
      {status === 'ok' && <span className="wmux-welcome-glyph-ok"><IconCheck size={14} /></span>}
      {status === 'warn' && <span className="wmux-welcome-glyph-warn"><IconWarning size={14} /></span>}
      {status === 'error' && <span className="wmux-welcome-glyph-error"><IconWarning size={14} /></span>}
      {status === 'todo' && <span className="wmux-welcome-todo" />}
      {status === 'running' && <span className="wmux-welcome-running-dot" />}
    </span>
  );
}

function FirstTaskStateRow({ task }: { task: FirstTaskState }) {
  const t = useT();
  const { phase, outcome } = task;
  if (phase === 'starting' || phase === 'waiting' || phase === 'late') {
    const detail = phase === 'late'
      ? t('firstRunWizard.firstTask.late')
      : task.still ? t('firstRunWizard.firstTask.stillWaiting') : null;
    return (
      <div className="ui-row" role="status" data-testid="first-run-first-task-waiting" data-phase={phase}>
        <RowIcon status={phase === 'late' ? 'todo' : 'running'} />
        <div className="ui-row-text">
          <p className="ui-row-title">
            {phase === 'starting' ? t('firstRunWizard.firstTask.starting') : t('firstRunWizard.firstTask.waiting')}
          </p>
          {detail && <p className="ui-row-detail">{detail}</p>}
        </div>
      </div>
    );
  }
  if (phase === 'answered' && outcome?.card) {
    const body = excerpt(outcome.card.body);
    return (
      <div className="ui-row" data-testid="first-run-first-task-answer">
        <RowIcon status="ok" />
        <div className="ui-row-text">
          <p className="ui-row-title">{outcome.card.title}</p>
          {body && <p className="ui-row-detail whitespace-pre-wrap">{body}</p>}
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className="ui-row" role="alert" data-testid="first-run-first-task-error">
        <RowIcon status="error" />
        <div className="ui-row-text">
          <p className="ui-row-title">
            {outcome?.card ? t('firstRunWizard.firstTask.botError') : t('firstRunWizard.firstTask.failed')}
          </p>
          {outcome?.message && <p className="ui-row-error">{outcome.message}</p>}
        </div>
      </div>
    );
  }
  return null;
}

/** "This task uses your Claude usage": the plan consent, asked here before
 *  anything is turned on, created or sent. Focus lands on the text, so a
 *  stray Enter answers nothing. */
function FirstTaskConsent({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const textRef = useRef<HTMLParagraphElement>(null);
  return (
    <Dialog role="alertdialog" width={440} onClose={onCancel} initialFocusRef={textRef} data-testid="first-run-first-task-consent">
      <DialogHeader title={t('firstRunWizard.firstTask.consent.title')} />
      <DialogBody>
        <p ref={textRef} tabIndex={-1} className="m-0 text-[13px] leading-snug text-[var(--text-sub)] outline-none">
          {t('firstRunWizard.firstTask.consent.body')}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" onClick={onCancel} data-testid="first-run-first-task-consent-cancel">
          {t('firstRunWizard.firstTask.consent.cancel')}
        </Button>
        <Button size="md" variant="primary" onClick={onConfirm} data-testid="first-run-first-task-consent-confirm">
          {t('firstRunWizard.firstTask.consent.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The step's footer action: Send before the task, Open the conversation
 *  once it is answered (or the wizard stopped waiting). Nothing while the
 *  task is on its way. */
export function FirstTaskFooterAction({ task, primary, onOpen }: { task: FirstTaskState; primary: boolean; onOpen: () => void }) {
  const t = useT();
  if (task.phase === 'answered' || task.phase === 'late') {
    return (
      <Button size="md" variant={primary ? 'primary' : 'secondary'} onClick={onOpen} data-testid="first-run-first-task-open">
        {t('firstRunWizard.firstTask.open')}
      </Button>
    );
  }
  if (task.phase !== 'idle' && task.phase !== 'consent') return null;
  return (
    <Button
      size="md"
      variant={primary && task.canSend ? 'primary' : 'secondary'}
      onClick={task.send}
      disabled={!task.canSend}
      data-task-text={task.taskText}
      data-testid="first-run-first-task-send"
    >
      {t('firstRunWizard.firstTask.send')}
    </Button>
  );
}
