import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import type { SshServiceResult } from '../../../shared/remoteHosts';
import { sshFailureKey } from './AddSshPcDialog';

// ─── "Start after reboot" on an SSH host ─────────────────────────────────────
//
// The host's own `wmux daemon install-service` decides; this only says what it
// answered: on, on but linger needs sudo (with the exact command), not
// supported there, or failed. The running daemon and web are never touched.

/** What the host answered, in the person's words. */
export function SshServiceNote({ result, name }: { result: SshServiceResult; name: string }) {
  const t = useT();
  if (result.ok && !result.on) {
    return <p className="wmux-remote-connect-note" data-testid="remote-ssh-service-off">{t('remoteSsh.service.off', { name })}</p>;
  }
  if (result.ok && result.lingerCommand) {
    return (
      <>
        <p className="wmux-a2a-note" data-tone="warning" data-testid="remote-ssh-service-linger">{t('remoteSsh.service.linger', { name })}</p>
        <div className="wmux-remote-code"><code className="ui-code">{result.lingerCommand}</code></div>
      </>
    );
  }
  if (result.ok) {
    return <p className="wmux-remote-connect-note" data-testid="remote-ssh-service-on">{t('remoteSsh.service.on', { name })}</p>;
  }
  const words = result.kind === 'service-unsupported'
    ? t('remoteSsh.service.unsupported', { name })
    : result.kind === 'failed' ? t('remoteSsh.service.failed', { name }) : t(sshFailureKey(result.kind), { alias: name });
  return (
    <>
      <p className="wmux-a2a-note" data-tone="warning" role="alert" data-testid="remote-ssh-service-failed">{words}</p>
      {result.message && (
        <p className="wmux-remote-connect-note"><code className="ui-code" style={{ overflowWrap: 'anywhere' }}>{result.message}</code></p>
      )}
    </>
  );
}

export interface SshServiceDialogProps {
  hostId: string;
  label: string;
  on: boolean;
  onClose: () => void;
}

/** Turns the service on or off as soon as it opens, then shows the answer. */
export default function SshServiceDialog({ hostId, label, on, onClose }: SshServiceDialogProps) {
  const t = useT();
  const [result, setResult] = useState<SshServiceResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const remote = window.electronAPI?.remote;
    void (remote?.sshService?.(hostId, on) ?? Promise.resolve(null)).then(
      (res) => { if (mounted.current) setResult(res ?? { ok: false, kind: 'failed', message: '' }); },
      () => { if (mounted.current) setResult({ ok: false, kind: 'failed', message: '' }); },
    );
    return () => { mounted.current = false; };
  }, [hostId, on]);

  return (
    <Dialog onClose={onClose} width={520} data-testid="remote-ssh-service">
      <DialogHeader title={t('remoteSsh.service.title', { name: label })} closeLabel={t('remotePage.connect.close')} />
      <DialogBody>
        <div className="wmux-remote-connect" role="status" aria-live="polite">
          {result === null
            ? <p className="wmux-remote-connect-note">{t('remoteSsh.service.working', { name: label })}</p>
            : <SshServiceNote result={result} name={label} />}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" size="md" onClick={onClose}>{t('remotePage.connect.done')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
