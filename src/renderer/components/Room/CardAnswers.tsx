// ─── The owner's answers to a plan or a proposal ───────────────────────────
//
// One component for every surface that shows a bot's plan or proposal: the
// HQ room's pinned plan, a proposal in the room timeline, and both in a Bots
// conversation. A plan takes Approve (the one primary), Edit and Decline; an
// edit opens the owner's revised plan in place and is sent as an approval
// with edits. A proposal takes Approve and Decline (both secondary). Every
// answer goes through room:resolve with the words the proposing role reads.
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import type { RoomsApi } from '../../hooks/useRoomSync';
import { FOCUS_RING } from '../focusRing';
import Button from '../ui/Button';
import { ApprovalAnswers } from './ApprovalAnswers';
import { OwnerRequestAnswers, isOwnerRequestCard } from './OwnerRequestAnswers';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The answers a plan card takes (room.resolve `resolution`). An edit is
 *  EDIT_PREFIX followed by the owner's revised plan. */
export const PLAN_RESOLUTION = { approve: 'approve', decline: 'decline', editPrefix: 'edit:\n' } as const;

/** room:resolve answers for a proposal card (the words the roles read). */
export const PROPOSAL_RESOLUTION = { approve: 'approve', decline: 'decline' } as const;

/** A workspace's name by id, or null when it is not one here (a plan's
 *  text names workspaces: roomFormat.planTextWithNames). */
export function useWorkspaceNames(): (id: string) => string | null {
  const names = useStore(useShallow(selectWorkspaceIdName));
  return useMemo(() => {
    const byId = new Map(names.map((w) => [w.id, w.name]));
    return (id: string) => byId.get(id) ?? null;
  }, [names]);
}

/** Send one answer; the error line says why one was not taken. */
function useAnswer(card: RoomCardData, workspaceId: string, api: RoomsApi | null, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (resolution: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.resolve({ workspaceId, cardId: card.id, resolution });
      if (!r.ok) setError(r.message);
      else onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, answer };
}

/** A plan's answers. Rendered as siblings (no wrapper), so a card that
 *  measures its rows (the HQ's pinned plan) sees each row. `onEditingChange`
 *  tells the host when the edit field opens or closes. */
export function PlanAnswers({ card, workspaceId, t, api, onEditingChange }: {
  card: RoomCardData;
  workspaceId: string;
  t: T;
  api: RoomsApi | null;
  onEditingChange?: (editing: boolean) => void;
}): React.ReactElement {
  const [editing, setEditingState] = useState(false);
  const [draft, setDraft] = useState(card.body ?? '');
  const setEditing = (v: boolean) => {
    setEditingState(v);
    onEditingChange?.(v);
  };
  const { busy, error, answer } = useAnswer(card, workspaceId, api, () => setEditing(false));
  const open = card.state === 'open';
  return (
    <>
      {open && !editing && (
        <div data-plan-actions data-card-answers="plan" className="shrink-0 mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" data-testid="hq-plan-decline" disabled={busy} onClick={() => void answer(PLAN_RESOLUTION.decline)}>{t('room.hq.decline')}</Button>
          <Button size="sm" variant="secondary" data-testid="hq-plan-edit" disabled={busy} onClick={() => setEditing(true)}>{t('room.hq.edit')}</Button>
          <Button size="sm" variant="primary" data-testid="hq-plan-approve" disabled={busy} onClick={() => void answer(PLAN_RESOLUTION.approve)}>{t('room.hq.approve')}</Button>
        </div>
      )}
      {editing && (
        <>
          <textarea
            data-testid="hq-plan-edit-input"
            aria-label={t('room.hq.editLabel')}
            value={draft}
            rows={5}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className={`mt-1.5 w-full rounded-[6px] border border-[var(--line)] focus:border-[var(--line-strong)] bg-transparent px-2 py-1.5 text-[13px] text-[var(--text-main)] outline-none ${FOCUS_RING}`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(card.body ?? ''); }} disabled={busy}>{t('room.hq.cancel')}</Button>
            <Button size="sm" variant="primary" data-testid="hq-plan-send-edit" disabled={busy || !draft.trim()} onClick={() => void answer(`${PLAN_RESOLUTION.editPrefix}${draft.trim()}`)}>
              {t('room.hq.sendEdit')}
            </Button>
          </div>
        </>
      )}
      {error && <p role="alert" className="shrink-0 mt-1 text-[11px] text-[var(--accent-red)]">{error}</p>}
    </>
  );
}

/** An open proposal's Approve / Decline (nothing without a rooms bridge). */
export function ProposalAnswers({ card, workspaceId, t, api }: { card: RoomCardData; workspaceId: string; t: T; api: RoomsApi | null }): React.ReactElement | null {
  const { busy, error, answer } = useAnswer(card, workspaceId, api);
  if (!api) return null;
  return (
    <div data-card-answers="proposal" className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="secondary" data-testid="room-proposal-decline" disabled={busy} onClick={() => void answer(PROPOSAL_RESOLUTION.decline)}>{t('room.hq.decline')}</Button>
      <Button size="sm" variant="secondary" data-testid="room-proposal-approve" disabled={busy} onClick={() => void answer(PROPOSAL_RESOLUTION.approve)}>{t('room.hq.approve')}</Button>
      {error && <p role="alert" className="basis-full text-[11px] text-[var(--accent-red)]">{error}</p>}
    </div>
  );
}

/** The answers a card takes, or nothing: a plan's or an open proposal's,
 *  or an approval request's (its state too, once answered). */
export function CardAnswers({ card, workspaceId, t, api, onEditingChange, readOnly }: {
  card: RoomCardData;
  workspaceId: string;
  t: T;
  api: RoomsApi | null;
  onEditingChange?: (editing: boolean) => void;
  /** The bots are paused: an approval shows its state, takes no answer. */
  readOnly?: boolean;
}): React.ReactElement | null {
  if (card.kind === 'approval') return <ApprovalAnswers card={card} t={t} readOnly={readOnly} />;
  if (card.actor.kind !== 'bot' || card.state !== 'open') return null;
  if (isOwnerRequestCard(card)) return <OwnerRequestAnswers card={card} t={t} />;
  if (card.kind === 'plan') return <PlanAnswers card={card} workspaceId={workspaceId} t={t} api={api} onEditingChange={onEditingChange} />;
  if (card.kind === 'proposal') return <ProposalAnswers card={card} workspaceId={workspaceId} t={t} api={api} />;
  return null;
}
