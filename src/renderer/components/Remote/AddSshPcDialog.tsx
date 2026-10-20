import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Field from '../ui/Field';
import Checkbox from '../ui/Checkbox';
import { SshServiceNote } from './SshServiceDialog';
import { FOCUS_RING } from '../focusRing';
import type { SshAddFailure, SshAddPhase, SshAddResult, SshServiceResult } from '../../../shared/remoteHosts';
import type { TranslationKey } from '../../i18n/locales/en';

// ─── "Add PC over SSH" ───────────────────────────────────────────────────────
//
// Pick a Host from ~/.ssh/config (or type user@host), press Install, and main
// does the rest over the user's own ssh: install the wmux server there, start
// `wmux web` on loopback, pair this computer, and register the host, which
// then shows up in the PC switcher. Key or agent auth only: when ssh would
// need a password or a host-key answer, the dialog says to run `ssh <alias>`
// once in a terminal instead of asking here.

/** What the person may type: an alias or user@host, never an option. */
const ALIAS_RE = /^[A-Za-z0-9_.@%+:[\]-]{1,255}$/;
export function isTypedSshTarget(value: string): boolean {
  return ALIAS_RE.test(value) && !value.startsWith('-');
}

const PHASES: SshAddPhase[] = ['connect', 'probe', 'install', 'start', 'pair', 'register'];

/** The words for a failure kind; ssh-side prompts point at a terminal. */
export function sshFailureKey(kind: string): TranslationKey {
  switch (kind) {
    case 'auth':
    case 'host-key-unknown':
      return 'remoteSsh.error.runSshOnce';
    case 'host-key-changed':
    case 'needs-confirmation':
      return 'remoteSsh.error.hostKeyChanged';
    case 'unreachable':
      return 'remoteSsh.error.unreachable';
    case 'ssh-missing':
      return 'remoteSsh.error.sshMissing';
    case 'forward-conflict':
      return 'remoteSsh.error.forwardConflict';
    case 'desktop-installed':
      return 'remoteSsh.error.desktopInstalled';
    case 'unsupported-os':
    case 'unsupported-arch':
    case 'musl':
    case 'glibc-too-old':
      return 'remoteSsh.error.unsupported';
    case 'missing-tools':
      return 'remoteSsh.error.missingTools';
    case 'no-manifest':
      return 'remoteSsh.error.noManifest';
    case 'download-failed':
    case 'checksum-mismatch':
    case 'install-failed':
      return 'remoteSsh.error.installFailed';
    case 'pair-unsupported':
      return 'remoteSsh.error.pairUnsupported';
    case 'pair-busy':
      return 'remoteSsh.error.pairBusy';
    case 'install-busy':
      return 'remoteSsh.error.installBusy';
    case 'web-stopped':
      return 'remoteSsh.error.webStopped';
    case 'already-registered':
      return 'remoteSsh.error.alreadyAdded';
    default:
      return 'remoteSsh.error.failed';
  }
}

export interface AddSshPcDialogProps {
  onClose: () => void;
  /** The host was registered (the PC switcher picks it up on its next refresh). */
  onAdded?: (hostId: string) => void;
}

type Step =
  | { kind: 'pick' }
  | { kind: 'working'; alias: string; phase: SshAddPhase }
  | { kind: 'failed'; alias: string; failure: SshAddFailure }
  | { kind: 'done'; label: string; upgradePending: boolean; viewOnly: boolean; service?: SshServiceResult };

export default function AddSshPcDialog({ onClose, onAdded }: AddSshPcDialogProps) {
  const t = useT();
  const remote = window.electronAPI?.remote;
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  // Opt-in, off by default: a login service outlives this dialog on someone else's computer.
  const [startAfterReboot, setStartAfterReboot] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const requestRef = useRef('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void (remote?.sshCandidates?.() ?? Promise.resolve([])).then(
      (list) => { if (live) setCandidates(list); },
      () => { if (live) setCandidates([]); },
    );
    const off = remote?.onSshProgress?.((e) => {
      if (e.requestId !== requestRef.current) return;
      setStep((s) => (s.kind === 'working' ? { ...s, phase: e.phase } : s));
    });
    return () => { live = false; mounted.current = false; off?.(); };
  }, [remote]);

  const typedTarget = typed.trim();
  const target = typedTarget ? (isTypedSshTarget(typedTarget) ? typedTarget : null) : picked;
  const working = step.kind === 'working';

  const install = async (alias: string) => {
    if (!remote?.sshAdd) return;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestRef.current = requestId;
    setStep({ kind: 'working', alias, phase: 'connect' });
    let res: SshAddResult;
    try {
      res = await remote.sshAdd(alias, requestId, undefined, startAfterReboot);
    } catch {
      res = { ok: false, kind: 'failed', message: '' };
    }
    if (!mounted.current || requestRef.current !== requestId) return;
    if (!res.ok && res.kind === 'cancelled') {
      setStep({ kind: 'pick' });
      return;
    }
    if (res.ok) {
      setStep({ kind: 'done', label: res.host.label, upgradePending: res.upgradePending, viewOnly: res.viewOnly === true, service: res.service });
      onAdded?.(res.host.id);
    } else {
      setStep({ kind: 'failed', alias, failure: res });
    }
  };

  // Cancel kills the ssh in flight; main stores nothing for it.
  const cancel = () => {
    const id = requestRef.current;
    requestRef.current = '';
    void remote?.sshCancel?.(id);
    setStep({ kind: 'pick' });
  };

  return (
    <Dialog
      onClose={() => { if (working) void remote?.sshCancel?.(requestRef.current); onClose(); }}
      onEscape={working ? cancel : undefined}
      width={520}
      closeOnBackdrop={!working}
      data-testid="remote-ssh-add"
    >
      <DialogHeader
        title={t('remoteSsh.title')}
        description={t('remoteSsh.description')}
        closeLabel={t('remotePage.connect.close')}
      />
      <DialogBody>
        {step.kind === 'pick' && (
          <div className="wmux-remote-connect" data-testid="remote-ssh-pick">
            {candidates === null ? (
              <p className="wmux-remote-connect-note">{t('remoteSsh.loadingHosts')}</p>
            ) : candidates.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="wmux-remote-connect-label" id="remote-ssh-hosts-label">{t('remoteSsh.fromConfig')}</span>
                <div
                  role="listbox"
                  aria-labelledby="remote-ssh-hosts-label"
                  className="flex flex-col overflow-hidden rounded-[10px] border border-[var(--line)] divide-y divide-[var(--stroke)] max-h-[220px] overflow-y-auto"
                  data-testid="remote-ssh-candidates"
                >
                  {candidates.map((alias) => {
                    const selected = !typedTarget && picked === alias;
                    return (
                      <button
                        key={alias}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`flex items-center min-h-[36px] px-3 text-left text-[13px] font-mono ${FOCUS_RING}`}
                        style={{ background: selected ? 'var(--selection)' : undefined }}
                        onClick={() => { setPicked(alias); setTyped(''); }}
                      >
                        <span className="truncate">{alias}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="wmux-remote-connect-note" data-testid="remote-ssh-no-config">{t('remoteSsh.noConfigHosts')}</p>
            )}
            <Field label={t('remoteSsh.typedLabel')} description={t('remoteSsh.typedHint')} layout="stacked">
              <Input
                type="text"
                value={typed}
                placeholder="user@host"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="font-mono"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && target) { e.preventDefault(); void install(target); }
                }}
                data-testid="remote-ssh-typed"
              />
            </Field>
            {typedTarget && !target && (
              <p className="wmux-a2a-note" data-tone="danger" role="alert">{t('remoteSsh.badTarget')}</p>
            )}
            <Field label={t('remoteSsh.startAfterReboot')} description={t('remoteSsh.startAfterRebootHint')}>
              <Checkbox checked={startAfterReboot} onCheckedChange={setStartAfterReboot} data-testid="remote-ssh-start-after-reboot" />
            </Field>
            <p className="wmux-remote-connect-note" data-testid="remote-ssh-consent">{t('remoteSsh.consent')}</p>
            <p className="wmux-remote-connect-note" data-testid="remote-ssh-agent-messages">{t('remote.agentMessagesNote')}</p>
          </div>
        )}
        {step.kind === 'working' && (
          <div className="wmux-remote-connect" role="status" aria-live="polite" data-testid="remote-ssh-working">
            <p className="wmux-remote-connect-note"><code className="ui-code">{step.alias}</code></p>
            <ol className="wmux-remote-order">
              {PHASES.map((phase, i) => {
                const at = PHASES.indexOf(step.phase);
                return (
                  <li key={phase} data-phase={phase} data-state={i < at ? 'done' : i === at ? 'active' : 'pending'}>
                    <span className="wmux-remote-order-n">{i + 1}</span>
                    <span style={{ color: i === at ? 'var(--text-main)' : 'var(--text-muted)' }}>{t(`remoteSsh.phase.${phase}` as TranslationKey)}</span>
                    <span />
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {step.kind === 'failed' && (
          <div className="wmux-remote-connect" data-testid="remote-ssh-failed">
            <p className="wmux-a2a-note" data-tone="danger" role="alert">
              {t(sshFailureKey(step.failure.kind), { alias: step.alias })}
            </p>
            {(step.failure.kind === 'auth' || step.failure.kind === 'host-key-unknown') && (
              <div className="wmux-remote-code" data-testid="remote-ssh-hint">
                <code className="ui-code">{`ssh ${step.alias}`}</code>
              </div>
            )}
            {step.failure.message && (
              <p className="wmux-remote-connect-note"><code className="ui-code" style={{ overflowWrap: 'anywhere' }}>{step.failure.message}</code></p>
            )}
          </div>
        )}
        {step.kind === 'done' && (
          <div className="wmux-remote-connect" role="status" data-testid="remote-ssh-done">
            <p className="wmux-remote-connect-note">{t('remoteSsh.added', { name: step.label })}</p>
            {step.viewOnly && <p className="wmux-a2a-note" data-tone="warning" data-testid="remote-ssh-view-only">{t('remoteSsh.viewOnly')}</p>}
            {step.upgradePending && <p className="wmux-a2a-note" data-tone="warning">{t('remoteSsh.upgradePending')}</p>}
            {step.service && <SshServiceNote result={step.service} name={step.label} />}
            <p className="wmux-remote-connect-note" data-testid="remote-ssh-done-agent-messages">{t('remote.agentMessagesNote')}</p>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {step.kind === 'pick' && (
          <>
            <Button variant="ghost" size="md" onClick={onClose}>{t('remotePage.connect.close')}</Button>
            <Button variant="primary" size="md" disabled={!target || !remote?.sshAdd} onClick={() => target && void install(target)} data-testid="remote-ssh-install">
              {t('remoteSsh.install')}
            </Button>
          </>
        )}
        {step.kind === 'working' && (
          <Button variant="secondary" size="md" onClick={cancel} data-testid="remote-ssh-cancel">{t('remoteSsh.cancel')}</Button>
        )}
        {step.kind === 'failed' && (
          <>
            <Button variant="ghost" size="md" onClick={() => setStep({ kind: 'pick' })}>{t('remoteSsh.back')}</Button>
            <Button variant="primary" size="md" onClick={() => void install(step.alias)} data-testid="remote-ssh-retry">{t('remoteSsh.retry')}</Button>
          </>
        )}
        {step.kind === 'done' && (
          <Button variant="primary" size="md" onClick={onClose}>{t('remotePage.connect.done')}</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
