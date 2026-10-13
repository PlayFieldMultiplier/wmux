// The Custom template: a bot the owner named and has yet to give a job.
// Job, powers and outputs only (common.ts).

import type { TemplateDefinition } from './common';

export const CUSTOM_TEMPLATE: TemplateDefinition = {
  template: 'custom',
  defaultJob:
    'You have no job yet. Help with what the owner asks, using your powers; when the owner gives you a job in their own words, it becomes yours (job_set).',
  powers: {},
  outputs: [
    'A `status` card for what you did, with links (PR, task id, SHA).',
    'An `opinion` card when the owner asks what you think.',
  ],
  wakes: [
    'task.done / task.failed for one of your tasks: post a status card and settle the task with ledger_update.',
  ],
};
