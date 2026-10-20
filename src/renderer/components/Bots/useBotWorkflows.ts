// The saved workflows of some bots, read through the factory bot port as the
// owner and re-read on every bot event (main sends one when a workflow
// changes). Cancel answers with the workflow as it now is, which replaces
// the one read (a revision only moves forward); a cancel refused because the
// workflow moved on re-reads.
// With no workflow port the list stays empty and there is no Cancel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerWorkflowCancelResult, WorkflowView } from '../../../shared/botWorkflow';
import type { RoomCard, ThreadId } from '../../../shared/room';
import { threadKey } from '../../../shared/botsWork';
import { getFactoryBotPort, type FactoryBotPort } from '../Room/factoryPorts';
import type { Conversation } from './botsModel';
import { conversationWorkflows } from './botsWorkflow';

export interface WorkflowOwner { botId: string; workspaceId: string }

const EMPTY: WorkflowView[] = [];

export function useBotWorkflows(owners: readonly WorkflowOwner[], port?: FactoryBotPort): {
  workflows: WorkflowView[];
  cancel?: (workflow: WorkflowView) => Promise<OwnerWorkflowCancelResult>;
} {
  const p = port ?? getFactoryBotPort();
  const [workflows, setWorkflows] = useState<WorkflowView[]>(EMPTY);
  const key = owners.map((o) => `${o.workspaceId}\u0000${o.botId}`).join('\u0001');
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    const read = p.readWorkflows;
    if (!p.available || !read || !key) {
      setWorkflows(EMPTY);
      return;
    }
    const list = key.split('\u0001').map((k) => {
      const [workspaceId, botId] = k.split('\u0000');
      return { botId, workspaceId };
    });
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      void Promise.all(list.map((o) => read(o).catch(() => null))).then((results) => {
        if (!live || mine !== seq) return;
        setWorkflows((prev) => list.flatMap((o, i) => {
          const r = results[i];
          // A failed read keeps what this bot showed.
          if (!r?.ok) return prev.filter((w) => w.botId === o.botId && w.workspaceId === o.workspaceId);
          // A read that left before a cancel answered never rolls it back.
          return r.workflows.map((w) => {
            const held = prev.find((x) => x.id === w.id);
            return held && held.revision > w.revision ? held : w;
          });
        }));
      });
    };
    reload.current = load;
    load();
    const off = p.subscribe(load);
    return () => {
      live = false;
      reload.current = () => undefined;
      off();
    };
  }, [p, key]);
  // Only the current bots' workflows, while a read for new ones is out.
  const shown = useMemo(() => {
    const current = new Set(key.split('\u0001'));
    return workflows.filter((w) => current.has(`${w.workspaceId}\u0000${w.botId}`));
  }, [workflows, key]);
  const cancelPort = p.cancelWorkflow;
  const cancel = useCallback(async (workflow: WorkflowView): Promise<OwnerWorkflowCancelResult> => {
    if (!cancelPort) return { ok: false, code: 'unavailable' };
    const r = await cancelPort({ botId: workflow.botId, workspaceId: workflow.workspaceId, workflowId: workflow.id, expectedRevision: workflow.revision });
    if (r.ok) setWorkflows((all) => all.map((w) => (w.id === r.workflow.id ? r.workflow : w)));
    else if (r.code === 'revision_conflict') reload.current();
    return r;
  }, [cancelPort]);
  return { workflows: shown, ...(cancelPort ? { cancel } : {}) };
}

/** The workflows a conversation shows (botsWorkflow.ts
 *  conversationWorkflows): a 1:1's bot's, a group's bots' (`cards`: the
 *  cards the conversation shows, whose threads are its). */
export function useConversationWorkflows(conversation: Conversation, cards: readonly RoomCard[], port?: FactoryBotPort): ReturnType<typeof useBotWorkflows> {
  const rows = conversation.kind === 'bot' ? [conversation.row] : conversation.bots;
  const { workflows, cancel } = useBotWorkflows(rows.map((r) => ({ botId: r.bot.id, workspaceId: r.bot.workspaceId })), port);
  const groupThread: ThreadId | null = conversation.kind === 'room' ? conversation.threadId : null;
  const threads = useMemo(() => new Set(groupThread ? cards.map((c) => threadKey(c.workspaceId, c.threadId)) : []), [cards, groupThread]);
  const shown = useMemo(
    () => conversationWorkflows(workflows, groupThread ? { kind: 'room', threadId: groupThread } : { kind: 'bot' }, threads),
    [workflows, groupThread, threads],
  );
  return { workflows: shown, ...(cancel ? { cancel } : {}) };
}
