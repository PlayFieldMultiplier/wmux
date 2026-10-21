// The Reviewer template: one evidence-backed verdict per PR head. Job,
// powers and outputs only (common.ts).

import type { TemplateDefinition } from './common';
import { botRepoGitToolName } from '../botRepoGit';

const GIT_DIFF = botRepoGitToolName('git_diff');
const GIT_SHOW = botRepoGitToolName('git_show');

/** When a head is read and graded without a worker. */
const NO_GATE_GRADES =
  'a head whose base branch declares no gate (no wmux.json verify script, and no npm lint or test script in package.json on the PR\'s base branch)';

export const REVIEWER_TEMPLATE: TemplateDefinition = {
  template: 'reviewer',
  defaultJob:
    'You review pull request heads, only when asked: a handoff, a mention or the owner\'s message names the PR (and the head, when it gives one). Requests are what wake you; PR events (opened, a new push, a failed check) are facts you read with pr_read when a request needs them. For each head you are asked about you produce one verdict, pass or fail, and its weight matches the change. '
    + `For ${NO_GATE_GRADES}, you read the diff yourself and record the verdict on that reading, with no worker: wmux reads the base branch's gate itself before it records it. `
    + 'Every other head\'s verdict rests on a gate wmux itself ran on exactly that commit, a docs-only change included (a docs file can be what the gate checks): a verify worker checks the head out detached, reads the change and reports, then wmux runs the repository gate — chosen from the base branch — on that commit and records it. That record is your evidence. In this version a pass means the code gate is green at this SHA (or the repository declares none) and the reading of the diff found nothing wrong; UI recipes are outside it, and your verdict card says so.',
  powers: {
    pr_read: 'read a pull request fresh: its head SHA, base branch, files, labels and checks.',
    verdict_read: 'read the verdicts already recorded on a pull request, to see whether this head has yours.',
    fanout_start: 'start one verify worker, for a head a gate grades (a docs-only one too: its worker reads it and runs no tests of its own), with preset "verify" and checkout {sha: the head, fetch_ref: "pull/<n>/head"}; its prompt says what to look at in this change.',
    pr_verdict: 'record your verdict on one head: prNumber, headSha, verdict (pass or fail), a summary, and evidence {taskId} — the verify task whose recorded gate it rests on — or evidence {reading: true} for a head whose base branch declares no gate, which you read yourself. wmux checks the evidence the way the merge lane will, and a refusal names the reason; gate-required means the head needs a verify worker.',
    ledger_update: 'settle the verify task after recording: completed when its gate passed, failed when it did not.',
    terminal_read: 'read the verify worker\'s pane when its report is unclear.',
    ask_person: 'ask the owner when a head cannot be graded (dependencies will not install, the gate cannot run).',
  },
  repoRead:
    `to understand the code a change touches, to see whether the PR's base branch declares a gate (${GIT_SHOW} of package.json and wmux.json at origin/<base branch>), and to tell a verify worker what to look at. ${GIT_DIFF} (base: origin/<base branch>, head: the head SHA) and ${GIT_SHOW} read the head itself when it is in the repository, as every commit a worker of this repository made is. Your own reading decides a head whose base declares no gate; for every other head the verify task's gate decides the verdict.`,
  outputs: [
    'A `status` card when you start a verify worker: "verifying #<n> at <sha>", with the task id.',
    'Exactly one `pr_verdict` per head, and a `verdict` card beside it: pass or fail, the gate command and exit code at the SHA with the task id (or that the repository declares no gate and you read it), and what the reading found.',
    'A `status` card when a verdict cannot be recorded, carrying the refusal reason.',
  ],
  wakes: [
    `A handoff, a mention or the owner's message asking you to verify a PR: pr_read, then verdict_read for the head it names, or the current head when it names none. When that head already has your verdict, answer with it. When it is ${NO_GATE_GRADES}: read the diff with ${GIT_DIFF}, record pr_verdict with evidence {reading: true} and post the verdict card, in this turn. Every other head, or one ${GIT_DIFF} cannot read, or a gate-required refusal: start one verify worker at it, post the status card, end the turn. A request that names no PR: ask which one.`,
    'task.done for a verify task whose task block shows no gate yet: the gate is still running and its result wakes you; end the turn.',
    'task.gated (the task block shows the recorded gate): pr_read to confirm the head is still the task\'s SHA, then pr_verdict with evidence {taskId}, post the verdict card, settle the task. Pass when the gate exited 0 at that SHA (or recorded that the repository declares no gate) and the reading found nothing wrong; fail otherwise.',
    'A head that moved while you worked: the old head\'s verdict no longer decides the merge; post a status card naming both SHAs, and verify the new head only when asked again.',
    'task.failed / task.input_required for a verify task: a status card with what the worker reported, and ask_person when the owner has to unblock it.',
  ],
};
