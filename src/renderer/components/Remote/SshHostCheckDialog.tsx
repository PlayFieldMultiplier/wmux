import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import type { SshConfirmResult } from '../../../shared/remoteHosts';
import type { SshHostBinding } from '../../../shared/sshPcContract';
import { sshFailureKey } from './AddSshPcDialog';

// ─── Check an SSH host's identity ────────────────────────────────────────────
//
// The tunnel refuses to send anything when the alias resolves to a different
// hostname or the host shows a different key than the one confirmed when it
// was added. This dialog shows what ssh sees now next to what was confirmed,
// and stores the new identity only when the person accepts exactly that.

export interface SshHostCheckDialogProps {
  hostId: string;
  label: string;
  onClose: () => void;
}

export default function SshHostCheckDialog({ hostId, label, onClose }: SshHostCheckDialogProps) {
  const t = useT();
  const remote = window.electronAPI?.remote;
  const [stored, setStored] = useState<SshHostBinding | null>(null);
  const [seen, setSeen] = useState<SshConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [repair, setRepair] = useState<{ ok: boolean; kind?: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const hosts = await remote?.hostsList().catch(() => []);
      const ssh = hosts?.find((h) => h.id === hostId)?.ssh ?? null;
      if (mounted.current) setStored(ssh);
      const now = await remote?.sshConfirm?.(hostId).catch(() => null);
      if (mounted.current) setSeen(now ?? { ok: false, kind: 'failed', message: '' });
    })();
    return () => { mounted.current = false; };
  }, [remote, hostId]);

  const changed = !!(seen?.ok && stored
    && (seen.resolvedHost !== stored.resolvedHost || seen.hostKeyFingerprint !== stored.hostKeyFingerprint));

  const accept = async () => {
    if (!seen?.ok || !remote?.sshConfirm) return;
    setBusy(true);
    const res = await remote.sshConfirm(hostId, { resolvedHost: seen.resolvedHost, hostKeyFingerprint: seen.hostKeyFingerprint }).catch(() => null);
    if (!mounted.current) return;
    setBusy(false);
    if (res?.ok && res.applied) onClose();
    else setSeen(res ?? { ok: false, kind: 'failed', message: '' });
  };

  // The host stopped accepting this computer: mint a fresh code over ssh.
  const pairAgain = async () => {
    if (!remote?.sshRepair) return;
    setBusy(true);
    setRepair(null);
    const res = await remote.sshRepair(hostId).catch(() => null);
    if (!mounted.current) return;
    setBusy(false);
    setRepair(res?.ok ? { ok: true } : { ok: false, kind: res && !res.ok ? res.kind : 'failed' });
  };

  const alias = stored?.alias ?? label;
  const row = (name: string, host: string, key: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="wmux-remote-connect-label">{name}</span>
      <code className="ui-code" style={{ overflowWrap: 'anywhere' }}>{host}</code>
      <code className="ui-code" style={{ overflowWrap: 'anywhere' }}>{key}</code>
    </div>
  );

  return (
    <Dialog onClose={onClose} width={520} data-testid="remote-ssh-check">
      <DialogHeader title={t('remoteSsh.check.title', { name: label })} closeLabel={t('remotePage.connect.close')} />
      <DialogBody>
        <div className="wmux-remote-connect">
          {seen === null ? (
            <p className="wmux-remote-connect-note" role="status">{t('remoteSsh.check.checking')}</p>
          ) : !seen.ok ? (
            <p className="wmux-a2a-note" data-tone="danger" role="alert">{t(sshFailureKey(seen.kind), { alias })}</p>
          ) : changed && stored ? (
            <>
              <p className="wmux-a2a-note" data-tone="warning" role="alert">{t('remoteSsh.error.hostKeyChanged', { alias })}</p>
              {row(t('remoteSsh.check.confirmed'), stored.resolvedHost, stored.hostKeyFingerprint)}
              {row(t('remoteSsh.check.now'), seen.resolvedHost, seen.hostKeyFingerprint)}
            </>
          ) : (
            <p className="wmux-remote-connect-note" data-testid="remote-ssh-check-same">{t('remoteSsh.check.same')}</p>
          )}
          {repair && (repair.ok
            ? <p className="wmux-remote-connect-note" role="status" data-testid="remote-ssh-repaired">{t('remoteSsh.check.paired')}</p>
            : <p className="wmux-a2a-note" data-tone="danger" role="alert">{t(sshFailureKey(repair.kind ?? 'failed'), { alias })}</p>)}
        </div>
      </DialogBody>
      <DialogFooter>
        {seen?.ok && !changed && remote?.sshRepair && (
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void pairAgain()} data-testid="remote-ssh-check-pair">
            {t('remoteSsh.check.pairAgain')}
          </Button>
        )}
        <Button variant={changed ? 'ghost' : 'primary'} size="md" onClick={onClose}>{t('remotePage.connect.done')}</Button>
        {changed && (
          <Button variant="destructive" size="md" disabled={busy} onClick={() => void accept()} data-testid="remote-ssh-check-accept">
            {t('remoteSsh.check.trust')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
