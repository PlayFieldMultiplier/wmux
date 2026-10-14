// ─── The Bots rail page (owner decision 2026-10-13) ──────────────────────
//
// The factory's bots, as a messenger: a conversation list on the left (search
// and "+" in its header; each row an avatar, the name and a one-line preview
// of the newest message, a needs-you badge on a bot that waits on the owner)
// and the selected conversation as a chat on the right (BotsChat). The
// HQ room is pinned first; the other rooms and every bot follow by latest
// activity. On a narrow sheet the list comes first and a conversation opens
// over it with a back button.
//
// The page covers the whole sheet, the room dock included: the conversation
// is the page here. Everything shown is derived from the room, bot and
// fan-out stores (botsModel.ts); the page owns no data.
//
// With no bot yet, the list offers one step: add a Lead to the current
// workspace (the add form, preset), whose conversation then opens with a
// hint for the first task. With the bots paused the page stays: the
// conversations and live workers read-only under a "Bots are paused" banner
// with Run bots. The header's menu holds Stop all bots (an inline confirm).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { refreshRoomStatus, type RoomsApi } from '../../hooks/useRoomSync';
import type { RoomCard } from '../../../shared/room';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import { IconMoreHorizontal, IconPlus, IconSearch } from '../icons';
import Popover from '../ui/Popover';
import { getFactoryBotPort, getFactorySettingsPort, type FactoryBotPort, type FactoryBotRow, type FactorySettingsPort } from '../Room/factoryPorts';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import { AddBotForm } from '../Settings/FactoryTab';
import { PresenceDot, botPresence } from '../Room/BotChips';
import { actorLabel, formatCardTime } from '../Room/roomFormat';
import BotAvatar from '../Room/BotAvatar';
import { RoomAvatar } from './BotsAvatar';
import { BotsChat } from './BotsChat';
import { openFactorySettings } from './botsAddBot';
import { withoutBotTasks } from '../Sidebar/botTasks';
import { listedWorkspaces } from '../../stores/slices/moaSlice';
import { allRoomCards, botConversationId, roomCardsByWorkspace, type Conversation } from './botsModel';
import { useBots, useBotsSync } from './useBots';
import { botsStopPort, stopAllSummary, type BotsStopPort } from './botsStop';
import { InlineConfirm } from './InlineConfirm';
import './bots.css';

type T = ReturnType<typeof useT>;

/** The conversation shown last, kept while the app runs (leaving the page
 *  and coming back opens it again). */
let lastSelected: string | null = null;

/** A conversation's name: the bot's own, or the room's workspace. */
export function conversationTitle(c: Conversation, workspaceName: (id: string) => string | null): string {
  if (c.kind === 'bot') return c.row.bot.name;
  return workspaceName(c.workspaceId) ?? c.workspaceId;
}

/** The row's one-line preview of the newest message. Pure. */
export function conversationPreview(
  c: Conversation,
  t: (key: string, vars?: Record<string, string | number>) => string,
  bots: readonly FactoryBotRow[],
  actors: Readonly<Record<string, { role: FactoryBotRow['bot']['role'] }>> = {},
): string {
  const last: RoomCard | null = c.last;
  if (!last) return t('botsPage.noMessages');
  if (last.actor.kind === 'human') return t('botsPage.you', { text: last.title });
  if (c.kind === 'room' && last.actor.kind === 'bot') return `${actorLabel(last.actor, t, bots, actors)}: ${last.title}`;
  return last.title;
}

/** The bots in `rows` that were not in `before`, by id. Pure. */
export function newBotIds(before: ReadonlySet<string>, rows: readonly FactoryBotRow[]): string[] {
  return rows.filter((r) => !before.has(r.bot.id)).map((r) => r.bot.id);
}

/** How long after the add form closes a new bot is still taken as the one
 *  it added (the list is re-read on the runtime's change push). */
const NEW_BOT_SELECT_MS = 10_000;

function NeedsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span data-bots-needs={count} aria-hidden="true" className="wmux-bots-badge">{count > 99 ? '99+' : count}</span>;
}

function ConversationRow({ c, title, preview, selected, t, onSelect, now }: {
  c: Conversation; title: string; preview: string; selected: boolean; t: T; onSelect: () => void; now?: number;
}) {
  const needsText = c.needsYou > 0 ? t('sidebar.fleetNeedsYou', { count: c.needsYou }) : '';
  const name = [title, c.kind === 'room' && c.isHq ? t('botsPage.hq') : '', needsText, preview].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      data-bots-row={c.id}
      data-bots-kind={c.kind}
      aria-current={selected ? 'true' : undefined}
      aria-label={name}
      onClick={onSelect}
      className={`wmux-bots-row-button ${selected ? 'is-selected' : ''} ${FOCUS_RING}`}
    >
      <span className="relative shrink-0">
        {c.kind === 'bot' ? <BotAvatar bot={c.row.bot} size={36} /> : <RoomAvatar bots={c.bots} size={36} />}
        {c.kind === 'bot' && (
          <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-[var(--bg-mantle)] p-[2px]"><PresenceDot presence={botPresence(c.row)} /></span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{title}</span>
          {c.kind === 'room' && c.isHq && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{t('botsPage.hq')}</span>}
          {c.last && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{formatCardTime(c.last.at, now)}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">{preview}</span>
          <NeedsBadge count={c.needsYou} />
        </span>
      </span>
    </button>
  );
}

/** The paused banner: the page is read-only until Run bots turns the bots
 *  back on (the factory setting, as Settings and the room dock write it). */
function PausedBanner({ t, settings }: { t: T; settings: FactorySettingsPort }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await settings.set({ enabled: true });
      if (!next) setError(t('settings.factory.notStarted'));
      await refreshRoomStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wmux-bots-banner" data-bots-paused role="status">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.paused')}</div>
        <div className="truncate text-[12px] text-[var(--text-muted)]">{error ?? t('botsPage.pausedDetail')}</div>
      </div>
      {settings.available ? (
        <Button size="sm" variant={busy ? 'secondary' : 'primary'} data-bots-run disabled={busy} onClick={() => void run()}>{t('botsPage.runBots')}</Button>
      ) : (
        <Button size="sm" variant="secondary" data-bots-open-settings onClick={openFactorySettings}>{t('botsPage.openSettings')}</Button>
      )}
    </div>
  );
}

/** The first step with no bot yet: add a Lead to the current workspace. */
function FirstLeadCard({ workspaceName, t, onAdd }: { workspaceName: string | null; t: T; onAdd: () => void }) {
  return (
    <div className="wmux-bots-first" data-bots-first-run>
      <div className="text-[13px] font-[var(--title-weight,500)] text-[var(--text-main)]">
        {workspaceName ? t('botsPage.firstLead', { workspace: workspaceName }) : t('botsPage.firstLeadAny')}
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{t('botsPage.firstLeadDetail')}</p>
      <Button size="sm" variant="primary" className="mt-2" data-bots-first-add onClick={onAdd}>{t('botsPage.firstLeadAction')}</Button>
    </div>
  );
}

/** The list header's menu: Stop all bots (only when main offers it). */
function HeaderMenu({ t, onStopAll }: { t: T; onStopAll: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-bots-menu
        aria-label={t('botsPage.menu')}
        title={t('botsPage.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`wmux-bots-icon-button ${open ? 'is-open' : ''} ${FOCUS_RING}`}
      >
        <IconMoreHorizontal size={16} />
      </button>
      {open && (
        <Popover
          role="menu"
          aria-label={t('botsPage.menu')}
          className="absolute right-0 top-full z-40 mt-1 min-w-[180px]"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          <button
            type="button"
            role="menuitem"
            data-bots-stop-all
            autoFocus
            onClick={() => { setOpen(false); onStopAll(); }}
            className={`ui-section-row w-full text-left text-[13px] text-[var(--accent-red)] ${FOCUS_RING}`}
          >
            {t('botsPage.stop.all')}
          </button>
        </Popover>
      )}
    </span>
  );
}

export default function BotsPage({ onAddBot, port, api, now, settings, stop }: {
  /** What "+" does instead of the in-page add form (tests). */
  onAddBot?: () => void;
  /** Tests: the bot port and the rooms bridge. */
  port?: FactoryBotPort;
  api?: RoomsApi | null;
  now?: number;
  /** Tests: the factory settings port (Run bots) and the stop verbs. */
  settings?: FactorySettingsPort;
  stop?: BotsStopPort;
} = {}): React.ReactElement {
  const t = useT();
  const botsState = useBots(port);
  useBotsSync(botsState, { focus: false, paused: true });
  // The factory may have been switched on since the status was read (in
  // Settings): opening the page asks again.
  useEffect(() => { void refreshRoomStatus(); }, []);
  const { model, status, bots, on } = botsState;
  const names = useStore(useShallow(selectWorkspaceIdName));
  const actors = useStore((s) => s.roomActors);
  const timelines = useStore((s) => s.roomTimelines);
  const cardsByWs = useMemo(() => roomCardsByWorkspace(timelines), [timelines]);
  // A 1:1 reads every room (a message to Moa may be posted in any of them).
  const everyCard = useMemo(() => allRoomCards(cardsByWs), [cardsByWs]);
  const nameOf = useMemo(() => {
    const byId = new Map(names.map((w) => [w.id, w.name]));
    return (id: string) => byId.get(id) ?? null;
  }, [names]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => lastSelected);
  // Narrow sheets show one column: the list, or the chat with a back button.
  const [view, setView] = useState<'list' | 'chat'>('list');

  const rows = useMemo(() => model.conversations.map((c) => ({
    c,
    title: conversationTitle(c, nameOf),
    preview: conversationPreview(c, t, bots, actors),
  })), [model.conversations, nameOf, t, bots, actors]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)) : rows;
  const selected = rows.find((r) => r.c.id === selectedId) ?? rows[0] ?? null;

  const selectedKey = selected?.c.id ?? null;
  useEffect(() => {
    if (selectedKey) lastSelected = selectedKey;
  }, [selectedKey]);

  const select = (id: string) => {
    setSelectedId(id);
    setView('chat');
  };

  // "+": the Settings add form in a dialog here (a build without the create
  // port opens the settings page instead). The bot it adds is selected once
  // the list shows it.
  const [adding, setAdding] = useState(false);
  // A bot belongs to one of the owner's workspaces: never a bot worker's or
  // another computer's (the sidebar's own list).
  const fanoutOrigin = useStore((s) => s.fanoutOrigin);
  const addWorkspaces = useMemo(() => withoutBotTasks(listedWorkspaces(names), fanoutOrigin), [names, fanoutOrigin]);
  const beforeAdd = useRef<Set<string>>(new Set());
  const awaitingNew = useRef<{ before: Set<string>; until: number } | null>(null);
  const canCreate = !!(port ?? getFactoryBotPort()).create;
  // The workspace a new bot goes to by default: the selected conversation's,
  // else (the first Lead) the current workspace when it is one of the
  // owner's, else none (the form picks its first).
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const currentWorkspace = addWorkspaces.find((w) => w.id === activeWorkspaceId) ?? addWorkspaces[0] ?? null;
  const [addTo, setAddTo] = useState<string | null>(null);
  const openAdd = (workspaceId: string | null) => {
    beforeAdd.current = new Set(bots.map((r) => r.bot.id));
    awaitingNew.current = null;
    setAddTo(workspaceId);
    setAdding(true);
  };
  const startAdd = onAddBot ?? (canCreate ? () => openAdd(selected?.c.workspaceId ?? null) : openFactorySettings);
  const startFirstLead = onAddBot ?? (canCreate ? () => openAdd(currentWorkspace?.id ?? null) : openFactorySettings);
  // Stop all: the header menu, then an inline confirm under the header.
  const stopPort = useMemo(() => stop ?? botsStopPort(port), [stop, port]);
  const settingsPort = settings ?? getFactorySettingsPort();
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopAll = async () => {
    if (!stopPort.stopAll) return;
    setStopping(true);
    try {
      const r = await stopPort.stopAll();
      useStore.getState().pushToast({ message: stopAllSummary(r, t), level: r.ok ? 'info' : 'error' });
      if (r.ok) setConfirmStopAll(false);
    } catch (err) {
      useStore.getState().pushToast({ message: `${t('botsPage.stop.failed')} ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
    } finally {
      setStopping(false);
    }
  };
  const finishAdd = () => {
    setAdding(false);
    awaitingNew.current = { before: beforeAdd.current, until: Date.now() + NEW_BOT_SELECT_MS };
  };
  useEffect(() => {
    const wait = awaitingNew.current;
    if (!wait) return;
    if (Date.now() > wait.until) { awaitingNew.current = null; return; }
    const [id] = newBotIds(wait.before, bots);
    if (!id) return;
    awaitingNew.current = null;
    setSelectedId(`bot:${id}`);
    setView('chat');
  }, [bots]);

  let body: React.ReactNode = null;
  if (status) {
    const paused = !on;
    body = (
      <>
        {paused && <PausedBanner t={t} settings={settingsPort} />}
        <div className="wmux-bots-body">
        <nav className="wmux-bots-list" aria-label={t('botsPage.conversations')}>
          <div className="wmux-bots-list-head">
            <h1 className="min-w-0 flex-1 truncate text-[16px] font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.title')}</h1>
            <button
              type="button"
              data-bots-search-toggle
              aria-label={t('botsPage.search')}
              title={t('botsPage.search')}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((v) => !v);
                if (!searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
                else setQuery('');
              }}
              className={`wmux-bots-icon-button ${searchOpen ? 'is-open' : ''} ${FOCUS_RING}`}
            >
              <IconSearch size={16} />
            </button>
            {stopPort.stopAll && <HeaderMenu t={t} onStopAll={() => setConfirmStopAll(true)} />}
            <button
              type="button"
              data-bots-add
              aria-label={t('botsPage.addBot')}
              title={t('botsPage.addBot')}
              onClick={startAdd}
              className={`wmux-bots-icon-button ${FOCUS_RING}`}
            >
              <IconPlus size={16} />
            </button>
          </div>
          {confirmStopAll && (
            <div className="px-4 pb-3">
              <InlineConfirm
                text={t('botsPage.stop.allConfirm')}
                confirmLabel={t('botsPage.stop.allAction')}
                cancelLabel={t('room.hq.cancel')}
                busy={stopping}
                onConfirm={() => void stopAll()}
                onCancel={() => setConfirmStopAll(false)}
                testId="bots-stop-all"
              />
            </div>
          )}
          {searchOpen && (
            <div className="px-3 pb-2">
              <input
                ref={searchRef}
                type="search"
                value={query}
                data-bots-search
                aria-label={t('botsPage.search')}
                placeholder={t('botsPage.search')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setQuery('');
                    setSearchOpen(false);
                  }
                }}
                className={`h-[28px] w-full rounded-[6px] border border-[var(--line)] bg-transparent px-2 text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-muted)] focus:border-[var(--line-strong)] ${FOCUS_RING}`}
              />
            </div>
          )}
          <div className="wmux-bots-rows">
            {on && bots.length === 0 && (
              <FirstLeadCard workspaceName={currentWorkspace?.name ?? null} t={t} onAdd={startFirstLead} />
            )}
            {shown.length === 0 && rows.length > 0 && <p className="px-4 py-3 text-[12px] text-[var(--text-muted)]">{t('botsPage.noMatch')}</p>}
            {rows.length === 0 && !(on && bots.length === 0) && <p data-bots-empty className="px-4 py-3 text-[12px] text-[var(--text-muted)]">{t('botsPage.noConversations')}</p>}
            {shown.map((r) => (
              <ConversationRow
                key={r.c.id}
                c={r.c}
                title={r.title}
                preview={r.preview}
                selected={selected?.c.id === r.c.id}
                t={t}
                now={now}
                onSelect={() => select(r.c.id)}
              />
            ))}
          </div>
        </nav>
        {selected ? (
          <BotsChat
            key={selected.c.id}
            conversation={selected.c}
            roomCards={selected.c.kind === 'bot' ? everyCard : cardsByWs.get(selected.c.workspaceId) ?? []}
            bots={bots}
            title={selected.title}
            workspaceName={nameOf(selected.c.workspaceId) ?? selected.c.workspaceId}
            t={t}
            api={api}
            now={now}
            onBack={() => setView('list')}
            readOnly={paused}
            stopPort={stopPort}
            jobPort={port ?? getFactoryBotPort()}
            resumePort={port ?? getFactoryBotPort()}
            onOpenBot={(botId) => select(botConversationId(botId))}
          />
        ) : (
          <p className="wmux-bots-chat flex items-center justify-center text-[12px] text-[var(--text-muted)]">{t(on && bots.length === 0 ? 'botsPage.firstRunChat' : 'botsPage.choose')}</p>
        )}
        </div>
      </>
    );
  }

  return (
    <div className="wmux-bots" data-bots-page data-view={view}>
      {body}
      {adding && (
        <Dialog onClose={() => setAdding(false)} width={520} data-testid="bots-add-bot">
          <DialogHeader title={t('settings.factory.addBot')} closeLabel={t('settings.close')} />
          <DialogBody>
            <AddBotForm
              onDone={finishAdd}
              workspaces={addWorkspaces}
              {...(addTo ? { defaultWorkspaceId: addTo } : {})}
              {...(port ? { port } : {})}
            />
          </DialogBody>
        </Dialog>
      )}
    </div>
  );
}
