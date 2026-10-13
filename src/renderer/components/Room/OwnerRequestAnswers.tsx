// ─── A bot's secret or login request, answered by the owner ────────────────
//
// An open `secret_request` card takes Enter key, which opens a dialog: who
// asked, the exact environment variable, the bot's label and reason as plain
// text (never markdown), and one password field. The value goes to main once
// (electronAPI.factory.secrets.set) and the field is cleared at once; main
// answers with the name only. An open `login_request` card takes Log in:
// GitHub runs the GitHub CLI sign-in (a device code), Claude asks for a
// terminal sign-in and checks it, a website opens its login page in a
// browser pane for the owner (nothing is filled in). Main closes the card
// and tells the bot once the owner is signed in.
import { useEffect, useRef, useState } from 'react';
import type { RoomCard } from '../../../shared/room';
import type { LoginService } from '../../../shared/botSecret';
import { BOT_SECRET_LIMITS } from '../../../shared/botSecret';
import { GH_DEVICE_URL, type GhLoginEvent } from '../../../shared/ghDeviceLogin';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import { openUrlInBrowserPane } from '../../utils/browserPaneActions';
import { useFactoryBots } from './useFactoryBots';
import { getBotSecretPort, type BotSecretPort } from './botSecrets';

type T = (key: string, vars?: Record<string, string | number>) => string;

export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

/** Whether a card is an owner request this component answers. Pure. */
export function isOwnerRequestCard(card: Pick<RoomCard, 'kind' | 'state' | 'actor'>): boolean {
  return (card.kind === 'secret_request' || card.kind === 'login_request') && card.state === 'open' && card.actor.kind === 'bot';
}

/** The words for a refusal main sent back (its code), else its message. */
export function secretErrorText(r: { code: string; message: string }, t: T): string {
  if (r.code === 'basic_text') return t('botSecret.noKeyring');
  if (r.code === 'encryption_unavailable') return t('botSecret.noEncryption');
  if (r.code === 'invalid_value') return t('botSecret.valueLength', { min: BOT_SECRET_LIMITS.VALUE_MIN });
  return r.message;
}

function useBotName(card: RoomCard, t: T): string {
  const bots = useFactoryBots(null);
  const id = card.actor.kind === 'bot' ? card.actor.botId : '';
  return bots.find((b) => b.bot.id === id)?.bot.name || t('botSecret.unknownBot');
}

/** One labelled line of the request, its text plain. */
function Detail({ label, children, mono }: { label: string; children: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-[var(--text-sub)]">{label}</span>
      <span className={`${mono ? 'font-mono ' : ''}whitespace-pre-wrap break-words text-[13px] text-[var(--text-main)]`}>{children}</span>
    </div>
  );
}

export function SecretRequestDialog({ card, t, onClose, port = getBotSecretPort() }: {
  card: RoomCard;
  t: T;
  onClose: () => void;
  port?: BotSecretPort;
}): React.ReactElement {
  const botName = useBotName(card, t);
  const name = card.refs?.secretName ?? '';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tooShort = value.length < BOT_SECRET_LIMITS.VALUE_MIN;
  const save = async () => {
    if (busy || tooShort) return;
    const sent = value;
    // The value leaves the renderer here and is not kept.
    setValue('');
    setBusy(true);
    setError(null);
    try {
      const r = await port.set({ name, value: sent, workspaceId: card.workspaceId, cardId: card.id });
      if (r.ok) onClose();
      else setError(secretErrorText(r, t));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={() => { setValue(''); onClose(); }} width={460} initialFocusRef={inputRef} data-testid="secret-request-dialog">
      <DialogHeader title={t('botSecret.dialogTitle')} description={t('botSecret.dialogDesc', { bot: botName })} closeLabel={t('botSecret.close')} />
      <DialogBody>
        <div className="flex flex-col gap-3">
          <Detail label={t('botSecret.askedBy')}>{botName}</Detail>
          <Detail label={t('botSecret.envName')} mono>{name}</Detail>
          <Detail label={t('botSecret.what')}>{card.title}</Detail>
          {card.body && <Detail label={t('botSecret.why')}>{card.body}</Detail>}
          <Field label={t('botSecret.value')} description={t('botSecret.valueHint', { min: BOT_SECRET_LIMITS.VALUE_MIN })} layout="stacked">
            <Input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={BOT_SECRET_LIMITS.VALUE_MAX}
              value={value}
              disabled={busy}
              data-testid="secret-request-value"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void save();
                }
              }}
              className="w-full text-[13px]"
            />
          </Field>
          {error && <p role="alert" className="text-[12px] text-[var(--accent-red)]">{error}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" disabled={busy} onClick={() => { setValue(''); onClose(); }}>{t('botSecret.cancel')}</Button>
        <Button variant="primary" size="md" disabled={busy || tooShort} data-testid="secret-request-save" onClick={() => void save()}>{t('botSecret.save')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

type GhFlow = { phase: 'idle' } | { phase: 'starting' } | { phase: 'code'; code: string } | { phase: 'failed'; message: string };

export function LoginRequestDialog({ card, t, onClose, port = getBotSecretPort() }: {
  card: RoomCard;
  t: T;
  onClose: () => void;
  port?: BotSecretPort;
}): React.ReactElement {
  const botName = useBotName(card, t);
  const service = card.refs?.label as LoginService | undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [gh, setGh] = useState<GhFlow>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);

  const check = async (done?: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await port.login({ workspaceId: card.workspaceId, cardId: card.id, ...(done ? { done: true } : {}) });
      if (!r.ok) setNote(r.message);
      else if (r.signedIn) onClose();
      else setNote(t('botSecret.loginNotYet'));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const checkRef = useRef(check);
  checkRef.current = check;

  // GitHub: the CLI's device sign-in, the Git page's flow.
  useEffect(() => {
    if (service !== 'github') return;
    const off = window.electronAPI?.github?.onLoginEvent?.((e: GhLoginEvent) => {
      if (e.kind === 'done') {
        setGh({ phase: 'idle' });
        void checkRef.current();
        return;
      }
      setGh((cur) => {
        if (cur.phase === 'idle') return cur;
        if (e.kind === 'code') return { phase: 'code', code: e.code };
        if (e.kind === 'timeout') return { phase: 'failed', message: t('botSecret.loginTimedOut') };
        if (e.kind === 'failed') return { phase: 'failed', message: e.message };
        return cur;
      });
    });
    return () => { off?.(); };
  }, [service, t]);

  const close = () => {
    if (gh.phase === 'starting' || gh.phase === 'code') void window.electronAPI?.github?.loginCancel?.()?.catch?.(() => undefined);
    onClose();
  };

  const startGh = async () => {
    setGh({ phase: 'starting' });
    try {
      const r = await window.electronAPI.github.loginStart();
      if (!r.ok) setGh({ phase: 'failed', message: r.message });
    } catch (err) {
      setGh({ phase: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const copy = async (text: string) => {
    try {
      await window.clipboardAPI?.writeText(text);
      setCopied(true);
    } catch { /* the text stays on screen */ }
  };

  let body: React.ReactNode = null;
  let primary: React.ReactNode = null;
  if (service === 'github') {
    body = (
      <>
        <p className="text-[13px] text-[var(--text-sub)]">{t('botSecret.loginGithubDesc')}</p>
        {gh.phase === 'code' && (
          <>
            <p className="text-[13px] text-[var(--text-sub)]">{t('botSecret.loginCode')}</p>
            <p className="font-mono text-[16px] tracking-wider text-[var(--text-main)]" data-testid="login-request-code">{gh.code}</p>
          </>
        )}
        {gh.phase === 'starting' && <p role="status" className="text-[12px] text-[var(--text-sub)]">{t('botSecret.loginStarting')}</p>}
        {gh.phase === 'failed' && <p role="alert" className="text-[12px] text-[var(--accent-red)]">{gh.message}</p>}
      </>
    );
    primary = gh.phase === 'code'
      ? <Button variant="primary" size="md" onClick={() => { void copy(gh.code); void window.electronAPI?.shell?.openExternal?.(GH_DEVICE_URL); }}>{t('botSecret.loginCopyOpen')}</Button>
      : <Button variant="primary" size="md" disabled={gh.phase === 'starting' || busy} data-testid="login-request-start" onClick={() => void startGh()}>{t('botSecret.loginGithubStart')}</Button>;
  } else if (service === 'website' && card.refs?.url) {
    const url = card.refs.url;
    body = (
      <>
        <p className="text-[13px] text-[var(--text-sub)]">{t('botSecret.loginWebsiteDesc')}</p>
        <p className="font-mono break-all text-[12px] text-[var(--text-main)]">{url}</p>
      </>
    );
    primary = opened
      ? <Button variant="primary" size="md" disabled={busy} data-testid="login-request-done" onClick={() => void check(true)}>{t('botSecret.loginDone')}</Button>
      : <Button variant="primary" size="md" data-testid="login-request-open" onClick={() => { openUrlInBrowserPane(url); setOpened(true); }}>{t('botSecret.loginOpen')}</Button>;
  } else if (service && service !== 'website') {
    // Claude Code (the remaining service).
    body = (
      <>
        <p className="text-[13px] text-[var(--text-sub)]">{t('botSecret.loginClaudeDesc')}</p>
        <div className="flex items-center gap-2">
          <code className="font-mono text-[12px] text-[var(--text-main)]">{CLAUDE_LOGIN_COMMAND}</code>
          <Button variant="secondary" size="sm" onClick={() => void copy(CLAUDE_LOGIN_COMMAND)}>{copied ? t('botSecret.copied') : t('botSecret.copy')}</Button>
        </div>
      </>
    );
    primary = <Button variant="primary" size="md" disabled={busy} data-testid="login-request-check" onClick={() => void check()}>{t('botSecret.loginCheck')}</Button>;
  }

  return (
    <Dialog onClose={close} width={460} data-testid="login-request-dialog">
      <DialogHeader title={card.title} description={t('botSecret.loginAskedBy', { bot: botName })} closeLabel={t('botSecret.close')} />
      <DialogBody>
        <div className="flex flex-col gap-3">
          {card.body && <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--text-main)]">{card.body}</p>}
          {body}
          {note && <p role="status" className="text-[12px] text-[var(--text-sub)]">{note}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="md" onClick={close}>{t('botSecret.cancel')}</Button>
        {service === 'github' && gh.phase === 'code' && (
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void check()}>{t('botSecret.loginCheck')}</Button>
        )}
        {primary}
      </DialogFooter>
    </Dialog>
  );
}

/** The card's answer: Enter key / Log in, and the dialog it opens. */
export function OwnerRequestAnswers({ card, t }: { card: RoomCard; t: T }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!isOwnerRequestCard(card)) return null;
  const secret = card.kind === 'secret_request';
  return (
    <div data-card-answers={card.kind} className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="primary" data-testid={secret ? 'secret-request-enter' : 'login-request-open-dialog'} onClick={() => setOpen(true)}>
        {secret ? t('botSecret.enter') : t('botSecret.login')}
      </Button>
      {open && (secret
        ? <SecretRequestDialog card={card} t={t} onClose={() => setOpen(false)} />
        : <LoginRequestDialog card={card} t={t} onClose={() => setOpen(false)} />)}
    </div>
  );
}
