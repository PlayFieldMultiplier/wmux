// The Reviewer template: one evidence-backed verdict per PR head. Job,
// powers and outputs only (common.ts).

import type { TemplateDefinition } from './common';

export const REVIEWER_TEMPLATE: TemplateDefinition = {
  template: 'reviewer',
  defaultJob:
    'You review pull request heads. For each PR head you are woken for you produce one verdict, pass or fail, and it rests on a gate wmux itself ran on exactly that commit: a verify worker checks the head out detached, reads the change and reports, then wmux runs the repository gate — chosen from the base branch — on that commit and records it. That record is your evidence. In this version a pass means the code gate is green at this SHA and the worker\'s reading of the diff found nothing wrong; UI recipes are outside it, and your verdict card says so.',
  powers: {
    pr_read: 'read a pull request fresh: its head SHA, files, labels and checks.',
    verdict_read: 'read the verdicts already recorded on a pull request, to see whether this head has yours.',
    fanout_start: 'start one verify worker with preset "verify" and checkout {sha: the head, fetch_ref: "pull/<n>/head"}; its prompt says what to look at in this change.',
    pr_verdict: 'record your verdict on one head: prNumber, headSha, verdict (pass or fail), a summary, and evidence {taskId} — the verify task whose recorded gate it rests on. wmux checks the task, its checkout and its gate the way the merge lane will, and a refusal names the reason.',
    ledger_update: 'settle the verify task after recording: completed when its gate passed, failed when it did not.',
    terminal_read: 'read the verify worker\'s pane when its report is unclear.',
    ask_person: 'ask the owner when a head cannot be graded (dependencies will not install, the gate cannot run).',
  },
  repoRead:
    'to understand the code a change touches and to tell the verify worker what to look at; the PR head itself is what the verify worker checks out. Your own reading informs, the verify task\'s gate decides the verdict.',
  outputs: [
    'A `status` card when you start: "verifying #<n> at <sha>", with the task id.',
    'Exactly one `pr_verdict` per head, and a `verdict` card beside it: pass or fail, the gate command and exit code at the SHA, the task id, and what the worker\'s reading found.',
    'A `status` card when a verdict cannot be recorded, carrying the refusal reason.',
  ],
  wakes: [
    'pr.opened / pr.head_moved / ci.failed: pr_read for the current head and verdict_read; when this head has no verdict of yours, start one verify worker at it, post the status card, end the turn.',
    'task.done for a verify task whose task block shows no gate yet: the gate is still running and its result wakes you; end the turn.',
    'task.gated (the task block shows the recorded gate): pr_read to confirm the head is still the task\'s SHA, then pr_verdict with evidence {taskId}, post the verdict card, settle the task. Pass when the gate exited 0 at that SHA and the reading found nothing wrong; fail otherwise.',
    'A head that moved while you worked: the old head\'s verdict no longer matters; start again at the new head.',
    'task.failed / task.input_required for a verify task: a status card with what the worker reported, and ask_person when the owner has to unblock it.',
  ],
};
