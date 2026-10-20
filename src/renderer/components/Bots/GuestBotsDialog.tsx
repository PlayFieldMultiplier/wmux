// ─── Guest bots: let an outside agent join one conversation ─────────────────
//
// Opened from the Bots page's "…" menu. The owner's switch for the whole
// feature, what the remote-access settings still block, the guests with
// Revoke, and Add guest: a name and one conversation (a bot's 1:1 or a group
// chat) of a guest workspace. A conversation elsewhere offers to make its
// workspace a guest workspace, with what that means, which is never undone.
// The guest workspaces are listed, and a guest whose workspace is not one
// (made before workspaces were flagged) shows as needing revoke. The new
// guest's token is shown once, here, with Copy; closing the dialog drops it.
// Everything else is read from the daemon each time the dialog opens or
// changes something.
import { useCallback, useEffect, useState } from 'react';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Switch from '../ui/Switch';
import Select from '../ui/Select';
import { FOCUS_RING } from '../focusRing';
import {
  GUEST_LIMITS, GUEST_NAME_MAX, GUEST_ROUTES, sanitizeGuestName,
  type GuestBotErrorCode, type GuestBotGates, type GuestBotView, type GuestScope, type GuestWorkspaceList, type GuestWorkspaceMarkResult,
} from '../../../shared/guestBots';
import { getGuestBotPort, getGuestRevocations, type GuestBotPort, type GuestRevocations } from './guestBots';
import { useStore } from '../../stores';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A conversation a guest may join, as the page lists it. */
export interface GuestConversationOption {
  scope: GuestScope;
  label: string;
}

const scopeKey = (s: GuestScope): string => `${s.workspaceId}\u0000${s.threadId}`;

const ERROR_KEYS: Record<GuestBotErrorCode, string> = {
  unavailable: 'botsPage.guest.error.unavailable',
  invalid: 'botsPage.guest.error.invalid',
  'too-many': 'botsPage.guest.error.tooMany',
  'not-found': 'botsPage.guest.error.notFound',
  'persist-failed': 'botsPage.guest.error.persistFailed',
  'not-guest-workspace': 'botsPage.guest.error.notGuestWorkspace',
};

/** What a refused "Make it a guest workspace" says. Pure. */
export function guestMarkError(r: Extract<GuestWorkspaceMarkResult, { ok: false }>, t: T, botName: (id: string) => string): string {
  if (r.code !== 'refused') return t(ERROR_KEYS[r.code]);
  if (r.refusal === 'hq') return t('botsPage.guest.markRefused.hq');
  if (r.refusal === 'live-work') return t('botsPage.guest.markRefused.liveWork');
  return t('botsPage.guest.markRefused.bots', { names: (r.botIds ?? []).map(botName).join(', ') });
}

/** What still keeps a guest from connecting, as message keys. Pure. */
export function guestGateNotes(g: GuestBotGates): string[] {
  const out: string[] = [];
  if (!g.serverRunning) return ['botsPage.guest.gate.server'];
  if (!g.secureTransport) out.push('botsPage.guest.gate.transport');
  if (!g.transcript) out.push('botsPage.guest.gate.transcript');
  else if (!g.input) out.push('botsPage.guest.gate.input');
  return out;
}

export default function GuestBotsDialog({ t, conversations, onClose, workspaceName = () => null, botName = (id) => id, port = getGuestBotPort(), revocations = getGuestRevocations() }: {
  t: T;
  conversations: readonly GuestConversationOption[];
  onClose: () => void;
  /** A workspace's name, or null when it is not known. */
  workspaceName?: (workspaceId: string) => string | null;
  /** A bot's name for a refusal that names bots. */
  botName?: (botId: string) => string;
  port?: GuestBotPort;
  /** Revokes in flight; they outlive this dialog. */
  revocations?: GuestRevocations;
}): React.ReactElement {
  const [guests, setGuests] = useState<GuestBotView[]>([]);
  const [gates, setGates] = useState<GuestBotGates | null>(null);
  const [flagged, setFlagged] = useState<GuestWorkspaceList | null>(null);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string>(conversations[0] ? scopeKey(conversations[0].scope) : '');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    void port.list().then((r) => {
      if (r.ok) {
        setGuests(r.guests);
        setGates(r.gates);
        setFlagged(r.workspaces ?? { readable: false, workspaceIds: [] });
      } else {
        setError(t(ERROR_KEYS[r.code]));
      }
    }, () => setError(t(ERROR_KEYS.unavailable)));
  }, [port, t]);
  useEffect(() => reload(), [reload]);

  const labelOf = (s: GuestScope): string => conversations.find((c) => scopeKey(c.scope) === scopeKey(s))?.label ?? s.threadId;
  const chosen = conversations.find((c) => scopeKey(c.scope) === pick) ?? null;
  const cleanName = sanitizeGuestName(name);
  const live = guests.filter((g) => !g.revokedAt);
  const isGuestWs = (ws: string): boolean => !!flagged?.readable && flagged.workspaceIds.includes(ws);
  const wsLabel = (ws: string): string => workspaceName(ws) ?? ws;
  const chosenGuest = !!chosen && isGuestWs(chosen.scope.workspaceId);

  const mark = async () => {
    if (!chosen || marking) return;
    setMarking(true);
    setError(null);
    const r = await port.markWorkspace(chosen.scope.workspaceId).catch(() => ({ ok: false as const, code: 'unavailable' as const }));
    setMarking(false);
    if (!r.ok) setError(guestMarkError(r, t, botName));
    reload();
  };

  const add = async () => {
    if (!cleanName || !chosen || !chosenGuest || busy) return;
    setBusy(true);
    setError(null);
    const r = await port.create({ name: cleanName, scope: chosen.scope }).catch(() => ({ ok: false as const, code: 'unavailable' as const }));
    setBusy(false);
    if (!r.ok) {
      setError(t(ERROR_KEYS[r.code]));
      reload();
      return;
    }
    setFresh({ name: r.guest.name, token: r.token });
    setCopied(false);
    setName('');
    reload();
  };
  // Revocations in flight, kept outside this dialog: closing it never hides
  // a failure (an unseen one becomes a persistent error toast).
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => revocations.pending());
  useEffect(() => {
    const offChange = revocations.onChange(() => setRevoking(revocations.pending()));
    const offOutcome = revocations.onOutcome(({ result }) => {
      if (!result.ok) setError(t(ERROR_KEYS[result.code]));
      reload();
      return true;
    });
    setRevoking(revocations.pending());
    return () => {
      offChange();
      offOutcome();
    };
  }, [revocations, reload, t]);
  const revoke = (g: GuestBotView) => {
    setError(null);
    void revocations.revoke(port, g.guestId, (r) => {
      useStore.getState().pushToast({
        level: 'error',
        persist: true,
        message: t('botsPage.guest.error.revokeFailed', { name: g.name, reason: t(ERROR_KEYS[r.code]) }),
      });
    });
  };
  const toggle = async (on: boolean) => {
    setError(null);
    const r = await port.setEnabled(on).catch(() => ({ ok: false as const, code: 'unavailable' as const }));
    if (!r.ok) setError(t(ERROR_KEYS[r.code]));
    reload();
  };
  const copy = () => {
    if (!fresh) return;
    void navigator.clipboard?.writeText(fresh.token).then(() => setCopied(true), () => undefined);
  };

  const notes = gates ? guestGateNotes(gates) : [];
  // The remote-access settings by the names the "web" panel shows them.
  const gateVars = {
    setting: notes.includes('botsPage.guest.gate.input') ? t('web.allowInput') : t('web.allowTranscript'),
    https: t('web.tailscale').split(/\s*—\s*/)[0],
    expose: t('web.expose'),
  };
  return (
    <Dialog onClose={onClose} width={560} data-testid="bots-guest-dialog">
      <DialogHeader title={t('botsPage.guest.title')} closeLabel={t('settings.close')} />
      <DialogBody>
        <div className="space-y-3 text-[12px]">
          <p className="text-[var(--text-sub)]" data-guest-intro>{t('botsPage.guest.intro')}</p>
          <label className="flex items-center gap-2">
            <Switch
              checked={gates?.enabled === true}
              disabled={!gates}
              aria-label={t('botsPage.guest.enable')}
              data-testid="guest-enable"
              onCheckedChange={(v) => void toggle(v)}
            />
            <span className="text-[var(--text-main)]">{t('botsPage.guest.enable')}</span>
          </label>
          {gates?.enabled && notes.map((k) => (
            <p key={k} role="status" data-guest-gate={k} className="rounded-[8px] bg-[var(--selection-subtle)] px-2 py-1 text-[var(--text-sub)]">{t(k, gateVars)}</p>
          ))}

          {fresh && (
            <div data-guest-token className="space-y-1 rounded-[10px] bg-[var(--selection-subtle)] px-3 py-2">
              <p className="font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.guest.tokenTitle', { name: fresh.name })}</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={fresh.token} aria-label={t('botsPage.guest.tokenTitle', { name: fresh.name })} data-testid="guest-token" className="min-w-0 flex-1 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
                <Button size="sm" variant="secondary" data-testid="guest-copy" onClick={copy}>{t(copied ? 'botsPage.guest.copied' : 'botsPage.guest.copy')}</Button>
              </div>
              <p className="text-[var(--text-muted)]">{t('botsPage.guest.tokenOnce')}</p>
              <p className="text-[var(--text-muted)]">{t('botsPage.guest.howTo', { path: GUEST_ROUTES.messages })}</p>
            </div>
          )}

          {flagged && !flagged.readable && (
            <p role="alert" data-guest-workspaces-unreadable className="text-[var(--accent-red)]">{t('botsPage.guest.workspacesUnreadable')}</p>
          )}
          {flagged?.readable && (
            <p className="text-[var(--text-sub)]" data-guest-workspaces>
              {flagged.workspaceIds.length > 0
                ? t('botsPage.guest.workspaces', { names: flagged.workspaceIds.map(wsLabel).join(', ') })
                : t('botsPage.guest.workspacesNone')}
            </p>
          )}

          <ul className="space-y-1" data-guest-list>
            {guests.length === 0 && <li className="text-[var(--text-muted)]" data-guest-empty>{t('botsPage.guest.empty')}</li>}
            {guests.map((g) => (
              <li key={g.guestId} data-guest-row={g.guestId} data-guest-revoked={g.revokedAt ? 'true' : undefined} data-guest-needs-revoke={!g.revokedAt && flagged?.readable && !isGuestWs(g.scope.workspaceId) ? 'true' : undefined} className="flex items-center gap-2">
                <span className={`min-w-0 flex-1 truncate ${g.revokedAt ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}>
                  {g.name}
                  <span className="text-[var(--text-muted)]">{` · ${labelOf(g.scope)} · ${g.revokedAt ? t('botsPage.guest.revoked')
                    : flagged?.readable && !isGuestWs(g.scope.workspaceId) ? t('botsPage.guest.needsRevoke')
                    : g.lastSeenAt ? t('botsPage.guest.lastSeen', { when: new Date(g.lastSeenAt).toLocaleString() }) : t('botsPage.guest.neverSeen')}`}</span>
                </span>
                {!g.revokedAt && (
                  <button
                    type="button"
                    data-testid={`guest-revoke-${g.guestId}`}
                    disabled={revoking.has(g.guestId)}
                    aria-busy={revoking.has(g.guestId) || undefined}
                    onClick={() => revoke(g)}
                    className={`text-[11px] text-[var(--accent-red)] hover:underline disabled:opacity-60 disabled:no-underline ${FOCUS_RING}`}
                  >
                    {t(revoking.has(g.guestId) ? 'botsPage.guest.revoking' : 'botsPage.guest.revoke')}
                  </button>
                )}
              </li>
            ))}
          </ul>

          {conversations.length === 0 ? (
            <p className="text-[var(--text-muted)]" data-guest-no-conversations>{t('botsPage.guest.noConversations')}</p>
          ) : (
            <>
            <p className="text-[var(--text-sub)]" data-guest-read-notice>{t('botsPage.guest.readNotice')}</p>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <label className="flex min-w-[160px] flex-1 flex-col gap-1">
                <span className="text-[var(--text-muted)]">{t('botsPage.guest.name')}</span>
                <Input value={name} maxLength={GUEST_NAME_MAX} onChange={(e) => setName(e.target.value)} data-testid="guest-name" />
              </label>
              <label className="flex min-w-[160px] flex-1 flex-col gap-1">
                <span className="text-[var(--text-muted)]">{t('botsPage.guest.conversation')}</span>
                <Select value={pick} onChange={(e) => setPick(e.target.value)} data-testid="guest-conversation">
                  {conversations.map((c) => <option key={scopeKey(c.scope)} value={scopeKey(c.scope)}>{c.label}</option>)}
                </Select>
              </label>
              <Button type="submit" size="sm" variant="primary" data-testid="guest-add" disabled={!cleanName || !chosen || !chosenGuest || busy || live.length >= GUEST_LIMITS.liveMax}>
                {t('botsPage.guest.add')}
              </Button>
            </form>
            {chosen && flagged?.readable && !chosenGuest && (
              <div data-guest-mark-offer className="space-y-2 rounded-[12px] border border-[var(--line)] px-3 py-2">
                <p className="font-[var(--title-weight,500)] text-[var(--text-main)]">{t('botsPage.guest.notGuestWorkspace', { workspace: wsLabel(chosen.scope.workspaceId) })}</p>
                <p className="text-[var(--text-sub)]" data-guest-mark-warning>{t('botsPage.guest.markWarning')}</p>
                <div className="flex justify-end">
                  <Button size="sm" variant="secondary" data-testid="guest-mark" disabled={marking} aria-busy={marking || undefined} onClick={() => void mark()}>
                    {t('botsPage.guest.mark', { workspace: wsLabel(chosen.scope.workspaceId) })}
                  </Button>
                </div>
              </div>
            )}
            </>
          )}
          {error && <p role="alert" data-guest-error className="text-[var(--accent-red)]">{error}</p>}
        </div>
      </DialogBody>
    </Dialog>
  );
}
