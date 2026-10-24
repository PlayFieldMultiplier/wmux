import { useState } from 'react';
import type { ChatV2TerminalProcess } from '../../../shared/chatv2/ipc';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import { getChatV2Bridge } from './bridge';
import { setKnownBinding } from './controller';

/**
 * "Continue in chat": the pane's terminal Claude (or a handed-off chat whose
 * TUI already exited) continues as a chat-v2 conversation with the same
 * session id. The daemon checks first and names what the stop would end; the
 * owner confirms; the daemon stops the TUI, proves it gone and starts the
 * chat. Nothing happens without the confirmation. The pane switches to the
 * chat view once the binding comes back.
 */
export function ContinueInChat({ paneId, tombstone = false, className, onError }: {
  paneId: string;
  /** The pane holds a handed-off chat whose TUI already exited: nothing is stopped. */
  tombstone?: boolean;
  className?: string;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<'idle' | 'checking' | 'confirm' | 'moving'>('idle');
  const [processes, setProcesses] = useState<ChatV2TerminalProcess[]>([]);
  const bridge = getChatV2Bridge();
  const platform = window.electronAPI?.platform;
  if (!bridge || (platform !== 'darwin' && platform !== 'linux')) return null;

  const check = async () => {
    setPhase('checking');
    onError('');
    const result = await bridge.call('fromTerminal', { paneId, preview: true }).catch(() => null);
    if (!result?.ok) {
      onError(result ? result.error.message : t('chat.continueInChatFailed'));
      setPhase('idle');
      return;
    }
    setProcesses(result.processes ?? []);
    setPhase('confirm');
  };
  const move = async () => {
    setPhase('moving');
    const result = await bridge.call('fromTerminal', { paneId }).catch(() => null);
    if (result?.ok && result.binding) {
      setKnownBinding(paneId, result.binding);
      setPhase('idle');
      return;
    }
    onError(result && !result.ok ? result.error.message : t('chat.continueInChatFailed'));
    setPhase('idle');
    // The pane's record may have changed (a tombstone put back): ask again.
    void bridge.call('bindingForPane', { paneId }).then((answer) => { if (answer.ok) setKnownBinding(paneId, answer.binding); }, () => undefined);
  };

  return (
    <>
      <button
        type="button"
        className={className}
        title={t('chat.continueInChatHint')}
        disabled={phase !== 'idle'}
        onClick={() => void check()}
        data-chatv2-from-terminal
      >
        {phase === 'checking' ? t('chat.continueInChatChecking') : phase === 'moving' ? t('chat.continueInChatMoving') : t('chat.continueInChat')}
      </button>
      {(phase === 'confirm' || phase === 'moving') && (
        <Dialog onClose={() => { if (phase === 'confirm') setPhase('idle'); }} width={420} closeOnBackdrop={phase === 'confirm'} data-testid="continue-in-chat-confirm">
          <DialogHeader
            title={t('chat.continueInChatTitle')}
            description={t(tombstone ? 'chat.continueInChatTombstoneDescription' : 'chat.continueInChatDescription')}
          />
          {!tombstone && (
            <DialogBody>
              {processes.length > 0 ? (
                <>
                  <p className="text-[13px] text-[var(--text-main)]">{t('chat.continueInChatStops')}</p>
                  <ul className="mt-1 list-disc pl-5 text-[13px] text-[var(--text-main)]" data-continue-in-chat-processes>
                    {processes.map((p, i) => <li key={`${p.name}:${i}`}>{p.mcp ? t('chat.continueInChatMcp', { name: p.name }) : p.name}</li>)}
                  </ul>
                </>
              ) : (
                <p className="text-[13px] text-[var(--text-main)]">{t('chat.continueInChatNothingElse')}</p>
              )}
              <p className="mt-2 text-[11px] text-[var(--text-sub)]">{t('chat.continueInChatSurvivors')}</p>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" size="sm" disabled={phase === 'moving'} onClick={() => setPhase('idle')} data-continue-in-chat-cancel>
              {t('common.cancel')}
            </Button>
            {/* In flight it is no longer the primary (DESIGN.md: one primary per surface). */}
            <Button variant={phase === 'moving' ? 'secondary' : 'primary'} size="sm" disabled={phase === 'moving'} onClick={() => void move()} data-continue-in-chat-confirm>
              {phase === 'moving' ? t('chat.continueInChatMoving') : t('chat.continueInChat')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
