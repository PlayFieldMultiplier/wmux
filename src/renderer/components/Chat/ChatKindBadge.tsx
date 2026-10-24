import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';

/**
 * Names which chat a pane shows: chat 1 follows the agent running in the
 * terminal, chat 2 talks to the agent on its own. Neutral on purpose — the
 * kind is not a state, so it carries no colour.
 */
export function ChatKindBadge({ kind }: { kind: 'terminal' | 'chatOnly' }) {
  const t = useT();
  return <Badge className="wmux-chat-kind" data-chat-kind={kind} title={t(`chat.kind.${kind}Hint`)}>{t(`chat.kind.${kind}`)}</Badge>;
}
