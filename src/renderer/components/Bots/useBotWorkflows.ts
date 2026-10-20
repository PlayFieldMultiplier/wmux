// The saved workflows of some bots, read through the factory bot port as the
// owner and re-read on every bot event (main sends one when a workflow
// changes). Cancel answers with the workflow as it now is, which replaces
// the one read (a revision only moves forward); a cancel refused because the
// workflow moved on re-reads.
// With no workflow port the list stays empty and there is no Cancel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerWorkflowCancelResult, WorkflowView } from '../../../shared/botWorkflow';
import { GENERAL_THREAD, dmThreadId, type ThreadId } from '../../../shared/room';
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
  const cancelPort = p.cancelWorkflow;
  const cancel = useCallback(async (workflow: WorkflowView): Promise<OwnerWorkflowCancelResult> => {
    if (!cancelPort) return { ok: false, code: 'unavailable' };
    const r = await cancelPort({ botId: workflow.botId, workspaceId: workflow.workspaceId, workflowId: workflow.id, expectedRevision: workflow.revision });
    if (r.ok) setWorkflows((all) => all.map((w) => (w.id === r.workflow.id ? r.workflow : w)));
    else if (r.code === 'revision_conflict') reload.current();
    return r;
  }, [cancelPort]);
  return { workflows, ...(cancelPort ? { cancel } : {}) };
}

/** The workflows a conversation shows: a 1:1's bot's, saved from its 1:1
 *  or General (where a wake with no conversation saves one); a group's
 *  bots', saved from the group. */
export function useConversationWorkflows(conversation: Conversation, port?: FactoryBotPort): ReturnType<typeof useBotWorkflows> {
  const rows = conversation.kind === 'bot' ? [conversation.row] : conversation.bots;
  const { workflows, cancel } = useBotWorkflows(rows.map((r) => ({ botId: r.bot.id, workspaceId: r.bot.workspaceId })), port);
  const threads: ThreadId[] = conversation.kind === 'bot' ? [dmThreadId(conversation.row.bot.id), GENERAL_THREAD] : [conversation.threadId];
  const key = threads.join('\u0000');
  const shown = useMemo(() => conversationWorkflows(workflows, key.split('\u0000') as ThreadId[]), [workflows, key]);
  return { workflows: shown, ...(cancel ? { cancel } : {}) };
}
