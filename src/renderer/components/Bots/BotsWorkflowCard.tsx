// ─── A bot's saved workflow, as one card (botsWorkflow.ts) ───────────────
//
// The work card's look (DESIGN.md › Bots › Threads): a 14px-radius card
// whose only boundary is a `--line` hairline, no fill, colour on the state
// only. First, in 11px muted, "Workflow · <state> · Step N of M": a steady
// muted dot and Running, the needs-you dot and text while it is blocked
// (it waits for the owner's review), a success check and Done, a neutral
// "Cancelled by you". Then its title, why it stopped in plain words, and the
// last verified result: which step, what was verified (checks passed on a
// commit, or a merged PR) and when, with the result's summary. A running or
// blocked workflow has Cancel workflow, a destructive secondary that asks in
// place (InlineConfirm; the solid red only on its final confirm). Cancel
// stops the steps not yet started and leaves a running step's worker
// running; a refusal is one red line.
import { useState } from 'react';
import type { OwnerWorkflowCancelResult, WorkflowView } from '../../../shared/botWorkflow';
import Button from '../ui/Button';
import { formatNoticeTime } from '../Room/roomFormat';
import { fullTime } from './botsTimeline';
import { StateMark, stateClass } from './BotsWorkCard';
import type { WorkState } from './botsWork';
import { workflowCardView, type WorkflowCardView, type WorkflowReason, type WorkflowState } from './botsWorkflow';
import { InlineConfirm } from './InlineConfirm';

type T = (key: string, vars?: Record<string, string | number>) => string;

const MARK: Record<WorkflowState, WorkState> = { running: 'working', blocked: 'needsYou', cancelled: 'cancelled', done: 'done' };

function stateText(state: WorkflowState, t: T): string {
  switch (state) {
    case 'running': return t('botsPage.workflow.running');
    case 'blocked': return t('botsPage.workflow.blocked');
    case 'cancelled': return t('botsPage.workflow.cancelled');
    case 'done': return t('botsPage.worker.done');
  }
}

/** Why it stopped, in the owner's words. */
export function workflowReasonText(reason: WorkflowReason, t: T): string {
  switch (reason.kind) {
    case 'cancelled': return reason.running
      ? t('botsPage.workflow.reason.cancelledRunning', { step: reason.step })
      : reason.started
        ? t('botsPage.workflow.reason.cancelledStarted', { step: reason.step })
        : t('botsPage.workflow.reason.cancelled');
    case 'stopped': return t('botsPage.workflow.reason.stopped');
    case 'taskFailed': return t('botsPage.workflow.reason.taskFailed', { step: reason.step });
    case 'taskCancelled': return t('botsPage.workflow.reason.taskCancelled', { step: reason.step });
    case 'taskUnverified': return t('botsPage.workflow.reason.taskUnverified', { step: reason.step });
    case 'unknownDispatch': return t('botsPage.workflow.reason.unknownDispatch', { step: reason.step });
    case 'multipleTasks': return t('botsPage.workflow.reason.multipleTasks', { step: reason.step });
    case 'bindingChanged': return t('botsPage.workflow.reason.bindingChanged', { step: reason.step });
    case 'other': return t('botsPage.workflow.reason.other', { step: reason.step, reason: reason.text });
  }
}

function cancelFailedText(r: Extract<OwnerWorkflowCancelResult, { ok: false }>, t: T): string {
  switch (r.code) {
    case 'revision_conflict': return t('botsPage.workflow.cancelFailed.changed');
    case 'not_found': return t('botsPage.workflow.cancelFailed.gone');
    default: return t('botsPage.workflow.cancelFailed.other');
  }
}

function LastVerified({ last, t }: { last: NonNullable<WorkflowCardView['last']>; t: T }) {
  const what = last.mergedPr !== undefined
    ? t('botsPage.workflow.verifiedMerge', { pr: last.mergedPr })
    : t('botsPage.workflow.verifiedGate', { sha: (last.headSha ?? '').slice(0, 7) });
  const when = last.at !== undefined ? formatNoticeTime(last.at) : '';
  return (
    <div className="wmux-bots-workflow-last" data-bots-workflow-last>
      <div className="truncate">{t('botsPage.workflow.lastVerified', { step: last.step, title: last.title })}</div>
      <div className="text-[var(--text-muted)]" title={last.at !== undefined ? fullTime(last.at) : undefined}>
        <span data-bots-workflow-verified>{what}</span>
        {when && <span className="tabular-nums" data-bots-workflow-verified-at>{` · ${when}`}</span>}
      </div>
      {last.summary.trim() && <div className="wmux-bots-workflow-summary" data-bots-workflow-summary>{last.summary}</div>}
    </div>
  );
}

export interface BotsWorkflowCardProps {
  workflow: WorkflowView;
  t: T;
  /** Absent: no Cancel here. */
  onCancel?: (workflow: WorkflowView) => Promise<OwnerWorkflowCancelResult>;
}

export default function BotsWorkflowCard({ workflow, t, onCancel }: BotsWorkflowCardProps): React.ReactElement {
  const view = workflowCardView(workflow);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!onCancel) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onCancel(workflow);
      if (r.ok) setConfirming(false);
      else setError(cancelFailedText(r, t));
    } catch (err) {
      setError(`${t('botsPage.workflow.cancelFailed.other')} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const reason = view.reason ? workflowReasonText(view.reason, t) : '';
  return (
    <div className="wmux-bots-work" data-bots-workflow={workflow.id} data-workflow-state={view.state}>
      <div className="wmux-bots-work-meta">
        <span className="shrink-0">{t('botsPage.workflow.label')}</span>
        <span aria-hidden="true">·</span>
        <StateMark state={MARK[view.state]} />
        <span data-bots-workflow-state className={`shrink-0 ${stateClass(MARK[view.state]) ?? ''}`}>{stateText(view.state, t)}</span>
        {view.state !== 'done' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate tabular-nums">{t('botsPage.workflow.stepOf', { step: view.step, total: view.total })}</span>
          </>
        )}
      </div>
      <div className="wmux-bots-work-title" data-bots-workflow-title>{workflow.title}</div>
      {reason && <div className="wmux-bots-workflow-reason" data-bots-workflow-reason>{reason}</div>}
      {view.cancelledWhileBlocked && <div className="wmux-bots-workflow-reason" data-bots-workflow-cancelled-note>{t('botsPage.workflow.cancelledNote')}</div>}
      {view.last && <LastVerified last={view.last} t={t} />}
      {onCancel && view.canCancel && (
        <div className="wmux-bots-workflow-foot">
          {confirming ? (
            <InlineConfirm
              text={t('botsPage.workflow.cancelConfirm', { title: workflow.title })}
              confirmLabel={t('botsPage.workflow.cancel')}
              cancelLabel={t('botsPage.workflow.keep')}
              busy={busy}
              onConfirm={() => void run()}
              onCancel={() => { setConfirming(false); setError(null); }}
              testId="bots-workflow-cancel"
            />
          ) : (
            <Button size="sm" variant="destructive" data-testid="bots-workflow-cancel" onClick={() => setConfirming(true)}>{t('botsPage.workflow.cancel')}</Button>
          )}
          {error && <p className="text-[12px] text-[var(--accent-red)]" data-bots-workflow-error>{error}</p>}
        </div>
      )}
    </div>
  );
}
