import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { agentDisplayToSlug } from '../../../shared/agentIdentity';
import Button from '../ui/Button';
import { chatViewAskFor } from './chatViewFirstAsk';

/**
 * The one-time "Show this as a chat?" question, floated over the terminal the
 * first time Claude or Codex runs in it. Either answer is stored for that
 * agent, so it is never asked again; Settings stays the way to change it.
 */
export function ChatViewFirstAskCard({ ptyId, surfaceId }: { ptyId: string; surfaceId: string }) {
  const t = useT();
  const agent = useStore((s) => {
    const running = s.surfaceAgent[ptyId];
    if (!running?.name || s.agentAliveByPtyId?.[ptyId] === false) return null;
    return chatViewAskFor(s.chatViewFirstAsk, running.slug ?? agentDisplayToSlug(running.name));
  });
  if (!agent) return null;
  return (
    <div className="wmux-chat-first-ask" role="dialog" aria-label={t('chat.firstAsk.question')}>
      <p>{t('chat.firstAsk.question')}</p>
      <div className="wmux-chat-first-ask-actions">
        <Button variant="ghost" size="sm" onClick={() => useStore.getState().answerChatViewFirstAsk(agent, 'terminal')}>{t('chat.firstAsk.keep')}</Button>
        <Button variant="primary" size="sm" onClick={() => {
          const s = useStore.getState();
          s.answerChatViewFirstAsk(agent, 'show');
          s.setSurfaceViewMode(surfaceId, 'chat');
        }}>{t('chat.firstAsk.show')}</Button>
      </div>
    </div>
  );
}
