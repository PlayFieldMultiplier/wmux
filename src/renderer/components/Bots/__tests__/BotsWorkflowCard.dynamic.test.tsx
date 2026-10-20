// @vitest-environment jsdom
// A bot's saved workflow as a card: a blocked one says why in plain words
// and shows its last verified result; Cancel workflow asks in place and
// calls the owner IPC once on its confirm (never when the ask is
// dismissed); a cancelled one says so, and that a started step keeps its
// worker.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_BLOCK, workflowTaskBlocked, workflowView, type BotWorkflow, type OwnerWorkflowCancelRequest, type WorkflowView } from '../../../../shared/botWorkflow';
import type { ThreadId } from '../../../../shared/room';
import type { FactoryBotPort } from '../../Room/factoryPorts';
import { formatNoticeTime } from '../../Room/roomFormat';
import BotsWorkflowCard from '../BotsWorkflowCard';
import { useBotWorkflows } from '../useBotWorkflows';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHA = 'b'.repeat(40);
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join('|')})` : key);
const VERIFIED_AT = new Date(2026, 9, 20, 14, 2).getTime();

function workflow(p: Partial<BotWorkflow> = {}): WorkflowView {
  return workflowView({
    id: 'wf-000000000000000000000001', clientWorkflowId: 'c1', botId: 'bot-0000000a', workspaceId: 'w1', repoKey: 'github.com/o/r',
    threadId: 'dm:bot-0000000a' as ThreadId, tainted: false, title: 'Ship the flag', state: 'active', revision: 3, createdAt: 1, updatedAt: 2,
    steps: [
      { title: 'Add the flag', prompt: 'p1', state: 'completed', dispatchKey: 'k1', taskId: 'wtask-1', result: { taskId: 'wtask-1', rev: 4, headSha: SHA, summary: 'Flag added behind a setting', at: VERIFIED_AT } },
      { title: 'Document it', prompt: 'p2', state: 'waiting', dispatchKey: 'k2', taskId: 'wtask-2' },
    ],
    ...p,
  });
}

const cancelledOf = (w: WorkflowView): WorkflowView => workflowView({
  ...w, state: 'blocked', stoppedByOwner: true, revision: w.revision + 1,
  steps: [w.steps[0], { ...w.steps[1], state: 'blocked', error: WORKFLOW_BLOCK.cancelled }],
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = (sel: string) => host.querySelector(sel);
const click = async (sel: string) => {
  await act(async () => { (q(sel) as HTMLButtonElement).click(); });
};

/** The cards as the chat draws them: read and cancelled through the port. */
function Cards({ port, botId = 'bot-0000000a' }: { port: FactoryBotPort; botId?: string }) {
  const { workflows, cancel } = useBotWorkflows([{ botId, workspaceId: 'w1' }], port);
  return <>{workflows.map((w) => <BotsWorkflowCard key={w.id} workflow={w} t={t} onCancel={cancel} />)}</>;
}

function portWith(initial: WorkflowView) {
  let current = initial;
  const cancelWorkflow = vi.fn(async (req: OwnerWorkflowCancelRequest) => {
    current = cancelledOf(current);
    expect(req).toEqual({ botId: 'bot-0000000a', workspaceId: 'w1', workflowId: initial.id, expectedRevision: initial.revision });
    return { ok: true as const, workflow: current };
  });
  const port: FactoryBotPort = {
    available: true,
    list: async () => [],
    subscribe: () => () => undefined,
    act: async () => ({ ok: true }),
    readWorkflows: async () => ({ ok: true, workflows: [current] }),
    cancelWorkflow,
  };
  return { port, cancelWorkflow };
}

describe('BotsWorkflowCard', () => {
  it('a workflow blocked on step 2 shows its reason and the last verified result', () => {
    const w = workflow({ state: 'blocked', steps: [workflow().steps[0], { ...workflow().steps[1], state: 'blocked', error: workflowTaskBlocked('wtask-2', 'failed') }] });
    act(() => root.render(<BotsWorkflowCard workflow={w} t={t} onCancel={vi.fn()} />));
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.blocked');
    expect(q('[data-bots-workflow-reason]')?.textContent).toBe('botsPage.workflow.reason.taskFailed(2)');
    expect(host.textContent).not.toContain('wtask-2');
    expect(q('[data-bots-workflow-last]')?.textContent).toContain('botsPage.workflow.lastVerified(1|Add the flag)');
    expect(q('[data-bots-workflow-verified]')?.textContent).toBe(`botsPage.workflow.verifiedGate(${SHA.slice(0, 7)})`);
    expect(q('[data-bots-workflow-verified-at]')?.textContent).toBe(` · ${formatNoticeTime(VERIFIED_AT)}`);
    expect(q('[data-bots-workflow-summary]')?.textContent).toBe('Flag added behind a setting');
    expect(q('[data-testid="bots-workflow-cancel"]')).not.toBeNull();
  });

  it('Cancel calls the owner IPC once after the confirm, and the card then reads cancelled', async () => {
    const { port, cancelWorkflow } = portWith(workflow());
    await act(async () => { root.render(<Cards port={port} />); });
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.running');
    await click('[data-testid="bots-workflow-cancel"]');
    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(q('[data-testid="bots-workflow-cancel-confirm-row"]')).not.toBeNull();
    await click('[data-testid="bots-workflow-cancel-confirm"]');
    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.cancelled');
    expect(q('[data-bots-workflow-reason]')?.textContent).toBe('botsPage.workflow.reason.cancelledRunning(2)');
    expect(q('[data-testid="bots-workflow-cancel"]')).toBeNull();
  });

  it('a dismissed confirm calls nothing', async () => {
    const { port, cancelWorkflow } = portWith(workflow());
    await act(async () => { root.render(<Cards port={port} />); });
    await click('[data-testid="bots-workflow-cancel"]');
    await click('[data-testid="bots-workflow-cancel-cancel"]');
    expect(q('[data-testid="bots-workflow-cancel-confirm-row"]')).toBeNull();
    await click('[data-testid="bots-workflow-cancel"]');
    await act(async () => {
      q('[data-testid="bots-workflow-cancel-confirm-row"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.running');
  });

  it('a bot no longer in the conversation loses its card at once', async () => {
    const { port } = portWith(workflow());
    await act(async () => { root.render(<Cards port={port} />); });
    expect(q('[data-bots-workflow]')).not.toBeNull();
    port.readWorkflows = () => new Promise(() => undefined);
    await act(async () => { root.render(<Cards port={port} botId="bot-0000000b" />); });
    expect(q('[data-bots-workflow]')).toBeNull();
  });

  it('a cancelled workflow renders its state, with no Cancel', () => {
    act(() => root.render(<BotsWorkflowCard workflow={cancelledOf(workflow())} t={t} onCancel={vi.fn()} />));
    expect(q('[data-workflow-state]')?.getAttribute('data-workflow-state')).toBe('cancelled');
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.cancelled');
    expect(q('[data-bots-workflow-reason]')?.textContent).toBe('botsPage.workflow.reason.cancelledRunning(2)');
    expect(q('[data-testid="bots-workflow-cancel"]')).toBeNull();
  });

  it('a refused cancel says why in one line and keeps the workflow', async () => {
    const onCancel = vi.fn(async () => ({ ok: false as const, code: 'revision_conflict' as const }));
    act(() => root.render(<BotsWorkflowCard workflow={workflow()} t={t} onCancel={onCancel} />));
    await click('[data-testid="bots-workflow-cancel"]');
    await click('[data-testid="bots-workflow-cancel-confirm"]');
    expect(q('[data-bots-workflow-error]')?.textContent).toBe('botsPage.workflow.cancelFailed.changed');
    expect(q('[data-bots-workflow-state]')?.textContent).toBe('botsPage.workflow.running');
  });
});
