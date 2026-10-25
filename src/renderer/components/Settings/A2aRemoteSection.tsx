import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { A2aRemoteStatus } from '../../../shared/rpc';
import { FirewallNoticeView, ListenProblemView, useFirewall, useListenProblem } from '../Remote/FirewallNotice';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import UiButton from '../ui/Button';
import Switch from '../ui/Switch';
import Input from '../ui/Input';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';

// ─── Cross-PC A2A listener ───────────────────────────────────────────────────
//
// Settings › LAN keeps only the listener: on/off, its port, this PC's
// security code and whether it listens. Inviting, joining, the paired PCs and
// what each may see live on the Remote page (2026-10-22). The daemon is the
// source of truth (`a2a.remote.*`); the VIEW is pure (props only) so it
// renders under renderToStaticMarkup in a node test.

type T = (key: string, vars?: Record<string, string | number>) => string;

export type A2aRemotePlatform = 'darwin' | 'win32' | 'linux';

/** Bytes shown in the fingerprint chip; the full value is in the tooltip and the copy button. */
export const FINGERPRINT_CHIP_BYTES = 6;

/** The first `bytes` bytes of a `AA:BB:…` fingerprint, cut on a byte boundary, with an ellipsis. */
export function fingerprintPrefix(fp: string, bytes = FINGERPRINT_CHIP_BYTES): string {
  const parts = fp.split(':');
  return parts.length > bytes ? `${parts.slice(0, bytes).join(':')}…` : fp;
}

export interface A2aRemoteViewProps {
  status: A2aRemoteStatus;
  /** Picks the firewall hint under the port. */
  platform: A2aRemotePlatform;
  fingerprintCopied: boolean;
  onCopyFingerprint: () => void;
  busy: boolean;
  onToggleEnabled: (v: boolean) => void;
  portDraft: string;
  onPortDraft: (v: string) => void;
  onPortCommit: () => void;
  error: string | null;
  /**
   * The bind failure explained (who holds the port, Use port N), from the
   * container. Shown in place of the raw "Not listening" note.
   */
  listenNotice?: ReactNode;
  /** The firewall check of the running listener, from the container. */
  firewallNotice?: ReactNode;
  t: T;
}

/** `m:ss` for the invite countdown. */
export function formatRemaining(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function A2aRemoteView(props: A2aRemoteViewProps) {
  const { status, platform, fingerprintCopied, onCopyFingerprint, busy, onToggleEnabled, portDraft, onPortDraft, onPortCommit, error, listenNotice, firewallNotice, t } = props;
  return (
    <SettingsSection title={t('settings.a2aRemote')} description={t('settings.a2aRemoteSeparate')} data-testid="a2a-remote-section">
      <SettingRow label={t('settings.a2aRemoteEnable')} description={t('settings.a2aRemoteEnableDesc')}>
        <Switch
          checked={status.enabled}
          onCheckedChange={onToggleEnabled}
          aria-label={t('settings.a2aRemoteEnable')}
          disabled={busy}
        />
      </SettingRow>
      <SettingRow label={t('settings.a2aRemotePort')} description={t(`settings.a2aRemotePortDesc.${platform}`)}>
        <Input
          type="number"
          aria-label={t('settings.a2aRemotePort')}
          value={portDraft}
          min={1024}
          max={65535}
          disabled={busy}
          onChange={(e) => onPortDraft(e.target.value)}
          onBlur={onPortCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') onPortCommit(); }}
          className="settings-input tabular-nums text-center"
          style={{ width: 96 }}
        />
      </SettingRow>
      <SettingRow label={t('settings.a2aRemoteThisPc')} description={status.name}>
        <div className="flex items-center gap-2">
          <span data-testid="a2a-remote-fingerprint" className="ui-code" title={status.fingerprint256 ?? undefined}>
            {status.fingerprint256 ? fingerprintPrefix(status.fingerprint256) : '—'}
          </span>
          {status.fingerprint256 && (
            <UiButton variant="secondary" size="md" onClick={onCopyFingerprint} aria-label={t('settings.a2aRemoteFingerprintCopy')}>
              {fingerprintCopied ? t('settings.a2aRemoteInviteCopied') : t('settings.a2aRemoteInviteCopy')}
            </UiButton>
          )}
        </div>
      </SettingRow>
      {status.enabled && listenNotice}
      {status.enabled && !(listenNotice && !status.listening) && (
        <SettingNote data-testid="a2a-remote-listening" tone={status.listening && !status.lastError ? 'muted' : 'warning'}>
          {!status.listening
            ? t('settings.a2aRemoteNotListening', { error: status.lastError ?? '—' })
            : status.lastError
              ? t('settings.a2aRemotePortFailed', { error: status.lastError, port: status.port })
              : t('settings.a2aRemoteListening', { port: status.port })}
        </SettingNote>
      )}
      {status.enabled && status.listening && firewallNotice}
      {error && <SettingNote tone="danger">{error}</SettingNote>}
    </SettingsSection>
  );
}

export function A2aRemoteSection() {
  const t = useT();
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });
  const api = window.electronAPI?.a2aRemote;

  const [status, setStatus] = useState<A2aRemoteStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const [fingerprintCopied, setFingerprintCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Checked when the tab opens and when the listener starts or moves, never on the 3 s poll.
  const firewall = useFirewall('a2a', { enabled: status?.listening === true, checkKey: String(status?.port ?? '') });
  const failed = status?.enabled && status.lastErrorCode ? { code: status.lastErrorCode, port: status.lastErrorPort ?? status.port } : null;
  const problem = useListenProblem('a2a', failed ? `${failed.code}:${failed.port}` : null);

  // The port last shown, so a poll does not overwrite a port being typed.
  const shownPort = useRef<number | null>(null);
  const applyStatus = useCallback((s: A2aRemoteStatus) => {
    setStatus(s);
    if (shownPort.current !== s.port) {
      shownPort.current = s.port;
      setPortDraft(String(s.port));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!api) { setUnavailable(true); return; }
    const r = await ipcInvoke(() => api.status());
    // A daemon too old to know `a2a.remote.*` answers nothing usable.
    if (!r.ok || typeof r.data?.port !== 'number') { setUnavailable(true); return; }
    setUnavailable(false);
    applyStatus(r.data);
  }, [api, ipcInvoke, applyStatus]);

  useEffect(() => {
    void refresh();
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const off = daemonApi?.onConnected?.(() => void refresh());
    // Light poll while the LAN tab is open: the Remote page can turn the listener on.
    const poll = setInterval(() => void refresh(), 3000);
    return () => { off?.(); clearInterval(poll); };
  }, [refresh]);

  const configure = useCallback(async (patch: { enabled?: boolean; port?: number }) => {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      const r = await ipcInvoke(() => api.configure(patch));
      if (r.ok && typeof r.data?.port === 'number') applyStatus(r.data);
      else setError(t('settings.a2aRemoteActionFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, ipcInvoke, applyStatus, t]);

  const onPortCommit = useCallback(() => {
    if (!status) return;
    const n = Number(portDraft);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) { setPortDraft(String(status.port)); return; }
    if (n !== status.port) void configure({ port: n });
  }, [status, portDraft, configure]);

  const onCopyFingerprint = useCallback(async () => {
    if (!status?.fingerprint256) return;
    try {
      await window.clipboardAPI.writeText(status.fingerprint256);
      setFingerprintCopied(true);
      setTimeout(() => setFingerprintCopied(false), 2000);
    } catch {
      setError(t('settings.a2aRemoteActionFailed'));
    }
  }, [status, t]);

  if (unavailable) {
    return (
      <SettingsSection title={t('settings.a2aRemote')}>
        <SettingNote>{t('settings.a2aRemoteUnavailable')}</SettingNote>
      </SettingsSection>
    );
  }
  if (!status) {
    return (
      <SettingsSection title={t('settings.a2aRemote')}>
        <SettingNote>{t('settings.a2aRemoteLoading')}</SettingNote>
      </SettingsSection>
    );
  }

  const platform: A2aRemotePlatform =
    window.electronAPI?.platform === 'darwin' ? 'darwin' : window.electronAPI?.platform === 'linux' ? 'linux' : 'win32';
  return (
    <A2aRemoteView
      status={status}
      platform={platform}
      fingerprintCopied={fingerprintCopied}
      onCopyFingerprint={() => void onCopyFingerprint()}
      busy={busy}
      onToggleEnabled={(v) => void configure({ enabled: v })}
      portDraft={portDraft}
      onPortDraft={setPortDraft}
      onPortCommit={onPortCommit}
      error={error}
      listenNotice={failed ? (
        <ListenProblemView
          report={problem}
          fallback={status.listening ? null : t('settings.a2aRemoteNotListening', { error: status.lastError ?? '—' })}
          onUsePort={(port) => void configure({ port })}
          busy={busy}
          repair
          primary={false}
          listener="a2a"
          t={t}
        />
      ) : undefined}
      firewallNotice={<FirewallNoticeView c={firewall} listener="a2a" primary={false} seenAt={status.inboundSeenAt} t={t} />}
      t={t}
    />
  );
}
